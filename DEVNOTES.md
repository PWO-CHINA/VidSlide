# VidSlide 开发者备忘录

> 给接手的 AI（和人类开发者）的非公开技术笔记。
> 记录了代码中不明显的设计决策、踩过的坑和注意事项。

## 项目概况

- **定位**：从延河课堂桌面录屏视频中提取 PPT 幻灯片的单机工具
- **架构**：Python Flask 后端 + 原生 HTML/JS 前端（无框架），单进程多线程
- **当前版本**：v0.3.1
- **GitHub**：https://github.com/PWO-CHINA/VidSlide
- **Python**：3.11（Microsoft Store 版），虚拟环境在 `./venv`

## 核心文件职责

| 文件 | 行数（约） | 职责 |
|------|-----------|------|
| `app.py` | ~1250 | Flask 路由、多会话管理、SSE 推送、GPU 监控、系统资源采样 |
| `extractor.py` | ~295 | 视频帧差检测核心、场景切换识别、三档速度模式 |
| `exporter.py` | ~150 | PDF/PPTX/ZIP 导出 |
| `templates/index.html` | ~340 | 前端 HTML 模板（Tailwind CDN） |
| `static/js/main.js` | ~1230 | 前端全部逻辑：SSE、画廊、拖拽排序、localStorage 配置记忆 |
| `static/css/style.css` | ~200 | 自定义样式 |

## 重要设计决策 & 踩坑记录

### 1. GPU 监控 — Intel 核显兼容

**背景**：开发机是 Intel Iris Xe Graphics 核显（无独显），不支持 `nvidia-smi`。

**方案**：使用 Windows PDH (Performance Data Helper) 通配符计数器，通过 `typeperf` 命令采样：
```
\GPU Engine(*)\Utilization Percentage    — GPU 利用率（所有引擎类型）
\GPU Adapter Memory(*)\Shared Usage      — 核显共享内存使用量
```

**关键坑**：
- 使用 `typeperf -cf <file>` 从文件读取计数器名，避免命令行长度超限（WinError 206）
- 核显只有 **Shared Usage**，没有 Dedicated Usage；独显反之。代码中两者都尝试读取
- GPU Engine 有多种类型（3D、Copy、Video Decode 等），需要取**所有引擎的最大值**
- 通配符 `(*)` 让 typeperf 自动匹配当前所有 GPU 进程，无需手动枚举 PID
- PDH 计数器是动态的，进程启停会改变计数器列表，所以用通配符而不是固定名称

**代码位置**：`app.py` 第 148-280 行左右，`_discover_pdh_counters()`、`_init_pdh_counter_file()`、`_sample_pdh_counters()`、`_gpu_sample_loop()`

### 2. 三档速度模式

**参数对比**：

| 参数 | Eco | Fast | Turbo |
|------|-----|------|-------|
| 进程优先级 | BELOW_NORMAL | 正常 | 正常 |
| 节流 sleep | 8ms | 1ms | 1ms |
| 帧跳距 | 1×fps | 1×fps | **2×fps** |
| 比较分辨率 | 480p | 480p | **320p** |
| 稳定帧检测 | 0.5s × 2次 | 0.5s × 2次 | **0.3s × 1次** |

**代码位置**：`extractor.py` 第 100-115 行

**注意**：Turbo 偶尔会漏页（跳帧太大），这是已知的 trade-off，README 中有说明。

### 3. 前端 localStorage 配置记忆

**机制**：`main.js` 中的 `_loadPrefs()` / `_savePrefs()` / `_applyPrefsToPane()` / `_watchPrefs()`

**存储 key**：`vidslide_prefs`  
**保存的字段**：threshold, fast_mode, use_roi, use_gpu, enable_history, max_history, speed_mode

**注意点**：
- `_applyPrefsToPane(pane)` 在 `bindPaneEvents()` 的**末尾**调用，确保 DOM 元素已绑定事件
- `_watchPrefs(pane)` 监听 change 事件并自动保存，只保存**用户手动修改**的值

### 4. SSE 服务器推送

- 每个会话有独立的 SSE 连接（`/api/stream/<sid>`）
- 使用 `queue.Queue` 在 worker 线程和 SSE 生成器之间传递消息
- 前端用 `EventSource` 接收，根据 `event:` 类型分发处理
- 断连后前端每 5 秒自动重连

### 5. 多会话架构

- 每个浏览器 Tab 有独立 `session_id`（UUID）
- 最多 3 个并行会话
- 每个会话有独立缓存目录：`.vidslide_sessions/{sid}/`
- 全局清理接口 `/api/cleanup-all`

### 6. beforeunload 与关闭服务

- 点击「关闭服务」按钮后设置 `G._serverShutdown = true`
- `beforeunload` 事件中检查此标志，为 true 时跳过确认提示
- 否则在有未导出成果时弹出离开确认

## 已知问题 & 限制

1. **Nuitka 编译在中文 Windows 用户名下失败**：gcc (msvcrt 变体) 的 `std::filesystem` 在中文系统 locale 下有 Illegal byte sequence bug。需要安装 VS2022 C++ 工具使用 MSVC 编译，或者继续用 PyInstaller
2. **核显 GPU 加速可能反而更慢**：核显的视频硬解码加速效果有限，对某些视频可能还不如 CPU 软解。前端有提示建议核显用户关闭 GPU 加速
3. **Windows Store Python 路径问题**：Microsoft Store 版 Python 路径含长路径，部分工具（如 typeperf）在参数过长时会报 WinError 206

## 打包方式

### PyInstaller（当前在用）
```bash
.\venv\Scripts\activate
pyinstaller --onefile --noconsole --icon="logo.ico" --version-file="version.txt" --add-data "templates;templates" --add-data "static;static" --hidden-import extractor --hidden-import exporter --name "VidSlide" app.py
```
输出：`dist/VidSlide.exe`，约 72 MB

### Nuitka（理论更优但有 bug）
中文 Windows 用户名 + gcc msvcrt 变体 = `std::filesystem` 编译失败。解决方案：
- 安装 VS2022 C++ 桌面开发工具，用 `--msvc=latest`
- 或等 Nuitka 修复该 bug

## 版本号更新清单

发新版时需要同步修改：
1. `version.txt` — exe 版本元数据（filevers / prodvers / FileVersion / ProductVersion）
2. `README.md` — 更新日志
3. `extractor.py` 头部注释的版本号
4. `build_nuitka.bat` 中的 `--product-version`
5. Git tag：`git tag v0.x.x && git push origin v0.x.x`

## 依赖说明

`requirements.txt` 核心依赖：
- `flask` — Web 后端
- `opencv-python` — 视频处理 + 帧差检测
- `numpy` — 数组运算
- `Pillow` — 图像处理
- `python-pptx` — PPTX 导出
- `psutil` — 系统资源监控 + 进程优先级

## 给 AI 的提示

- 代码注释比较充分，直接读源码即可理解大部分逻辑
- GPU 监控部分最复杂（app.py 148-280 行），改动前务必理解 PDH 通配符方案
- 前端是纯 JS（无框架），DOM 操作较多，`main.js` 的 `G` 对象是全局状态
- 所有提取逻辑在后台线程执行（`_extraction_worker`），通过 SSE 队列推送进度
- 改完代码后用 `python app.py` 启动测试，浏览器会自动打开
