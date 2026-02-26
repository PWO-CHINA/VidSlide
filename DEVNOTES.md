# VidSlide 开发者备忘录

> 给接手的 AI（和人类开发者）的非公开技术笔记。
> 记录了代码中不明显的设计决策、踩过的坑和注意事项。

> **给接手 AI 的第一句话**：请先阅读 DEVNOTES.md 了解项目架构和历史问题。
> 项目根目录下 `.\venv` 是现有虚拟环境，`requirements.txt` 是依赖清单。
> 所有改动都已提交推送，可通过 `git log` 追溯设计演变。

## 项目概况

- **定位**：从延河课堂桌面录屏视频中提取 PPT 幻灯片的单机工具
- **架构**：Python Flask 后端 + 原生 HTML/JS 前端（无框架），单进程多线程
- **当前版本**：v0.4.1
- **GitHub**：https://github.com/PWO-CHINA/VidSlide
- **Gitee 镜像**：https://gitee.com/pwo101/VidSlide（国内下载更快）
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

### Nuitka（理论更优但有 bug，基本放弃）
中文 Windows 用户名 + gcc msvcrt 变体 = `std::filesystem` 编译失败。解决方案：
- 安装 VS2022 C++ 桌面开发工具，用 `--msvc=latest`（目前用户无法下载，其电脑各个盘内的空间都不足）
- 或等 Nuitka 修复该 bug

## 版本号更新清单

发新版时需要同步修改：
1. `version.txt` — exe 版本元数据（filevers / prodvers / FileVersion / ProductVersion）
2. `README.md` — 更新日志
3. `extractor.py` 头部注释的版本号
4. `build_nuitka.bat` 中的 `--product-version`
5. Git tag：`git tag v0.x.x && git push origin v0.x.x`
6. GitHub / Gitee Release：通过 API 或网页创建 Release，**exe 文件需在网页端手动上传附件**（GitHub API 和 Gitee API 均不支持通过当前工具链上传二进制文件；`gh` CLI 可以但需要 `gh auth login` 交互认证）

> **分工约定**：AI 负责创建 tag、Release 及版本说明；exe 附件由人类在 GitHub/Gitee 网页端上传。

## 依赖说明

`requirements.txt` 核心依赖：
- `flask` — Web 后端
- `opencv-python` — 视频处理 + 帧差检测
- `numpy` — 数组运算
- `Pillow` — 图像处理
- `python-pptx` — PPTX 导出
- `psutil` — 系统资源监控 + 进程优先级

## v0.3.2 修复的逻辑漏洞

| 漏洞 | 修复方案 | 代码位置 |
|------|---------|---------|
| `/api/select-video` 多标签页弹窗冲突 | `_video_select_lock = threading.Lock()`，非阻塞 acquire，占用时立即返回提示 | `app.py` `select_video()` |
| SSE `onerror` 死循环（Zombie 连接） | 前端 `sseErrorCount` 计数，连续 3 次出错后主动 `close()` 放弃重连 | `main.js` `connectSSE()` |
| `_extraction_worker` 异常静默崩溃 | 外层 `try/except Exception` 兜底，捕获后向前端推送 `error` 状态事件 | `app.py` `_extraction_worker()` |
| 孤儿会话占用标签页名额 | `_cleanup_orphan_sessions()` 定期清理无 SSE 连接的残留会话，`ORPHAN_SESSION_TIMEOUT=60s` | `app.py` `_heartbeat_watcher()` |

## 给 AI 的提示

- 代码注释比较充分，直接读源码即可理解大部分逻辑
- GPU 监控部分最复杂（app.py 148-280 行），改动前务必理解 PDH 通配符方案
- 前端是纯 JS（无框架），DOM 操作较多，`main.js` 的 `G` 对象是全局状态
- 所有提取逻辑在后台线程执行（`_extraction_worker`），通过 SSE 队列推送进度
- 改完代码后用 `python app.py` 启动测试，浏览器会自动打开

## v0.4.0 新增设计决策

### 7. 资源监控条合并进页眉

**背景**：资源监控条原本是独立的 `<div>`，位于 header 下方，被 header 的 `.scrolled` box-shadow 遮挡，视觉不协调。

**方案**：将 `.resource-bar` 移入 `<header>` 内部，使用 `rgba(0,0,0,.15)` 半透明背景融入页眉渐变色，`border-top` 用 `rgba(255,255,255,.08)` 微弱分隔。文字颜色改为白色半透明以匹配页眉色调。

**注意**：`body` 的 `padding-top` 从 64px 增加到 96px 以适应更高的 header。

### 8. Logo 深色模式处理

**背景**：原方案 `filter: invert(1) brightness(1.1)` 全反色，导致 Logo 在深色模式下颜色完全失真。

**方案**：改为 `filter: brightness(0.85) saturate(0.9)`，仅柔和降亮，保留原始色调。

### 9. 断连智能刷新

**背景**：原「立即刷新」按钮直接 `location.reload()`，后端未运行时会跳到浏览器的「拒绝连接」死页面，用户体验极差。

**方案**：
- 「检测并刷新」按钮先 `fetch('/api/heartbeat')` 探测后端
- 有响应 → `location.reload()` 正常刷新
- 无响应 → 在弹窗内提示「后端服务未运行，请手动重启」
- 自动重连最多 30 次（2.5 分钟），超时后停止并更新状态文案
- 后端断开时 `api()` 函数不再弹 toast（`_serverAlive` 标志位控制）

### 10. Flask 开发服务器警告

**背景**：`flask run` 会输出 `WARNING: This is a development server. Do not use it in a production deployment.`，对本地桌面工具无意义但看着不干净。

**为什么不用 waitress**：VidSlide 依赖 SSE（`text/event-stream` 流式响应），waitress 会缓冲整个 response 再发送，直接破坏 SSE 功能。Flask 内置服务器对本地单用户场景完全够用。

**方案**：`logging.getLogger('werkzeug').setLevel(logging.ERROR)` 抑制 WARNING 级别日志，只保留自定义启动横幅。

### 11. 跨浏览器标签页通信（BroadcastChannel）

**背景**：用户可能在多个浏览器标签页中打开 VidSlide。关闭服务时只有当前标签页显示「已关闭」，其他标签页会因心跳失败显示「后端断开」，体验不一致。

**方案**：
- 使用 `BroadcastChannel('vidslide')` 实现同源标签页间通信
- 关闭服务时广播 `{ type: 'shutdown' }` 消息，所有标签页同步显示关闭页面
- 新标签页打开时广播 `{ type: 'tab_active' }`，已有标签页回复 `{ type: 'tab_exists' }`
- 检测到重复标签页时显示提示页面，提供「强制打开」和「关闭此标签页」选项
- 「不再提示」选项存入 `localStorage('vidslide_no_dup_warn')`
- 「强制打开」使用 `sessionStorage('vidslide_force_open')` 一次性标记跳过检测（用完即删）

**代码位置**：`main.js` 顶部 `_bc` 变量 + `init()` 函数第零步

### 12. 关闭后自动关闭浏览器标签页

**背景**：关闭服务后页面停留在「已关闭」状态，几秒后心跳失败又弹出断连遮罩。

**方案**：
- `_showShutdownPage()` 先清除所有定时器（心跳、资源监控），防止后续触发断连检测
- 显示 5 秒倒计时后尝试 `window.close()`
- 浏览器安全限制：`window.close()` 只能关闭由 `window.open()` 打开的页面，`webbrowser.open` 打开的不算
- 降级方案：倒计时结束后提示「浏览器不允许自动关闭此页面，请手动关闭」
- `showDisconnectOverlay()` 增加 `G._serverShutdown` 检查，用户主动关闭后不再触发断连遮罩

**代码位置**：`main.js` `_showShutdownPage()` + `shutdownServer()`

## v0.4.1 新增设计决策

### 13. 任务管理器名称修正

**背景**：tkinter 的 `Tk()` 窗口即使调用了 `withdraw()` 隐藏，在 `withdraw()` 执行前的短暂时间内，窗口标题会出现在任务管理器中，导致显示"请选择上传一个视频"。

**方案**：在 `root.withdraw()` 之前先调用 `root.title('影幻智提 (VidSlide)')`，确保任务管理器始终显示正确名称。

**代码位置**：`app.py` `select_video()` 函数内的 `_pick()` 闭包。

### 14. 参数重置功能

**方案**：
- `_PREF_DEFAULTS` 常量对象集中定义所有参数的默认值，便于后续维护
- `_resetPrefs(pane)` 清除 localStorage 中的 `vidslide_prefs`，并将 DOM 元素直接写回默认值
- 重置按钮 `.js-btn-reset-prefs` 放在参数面板底部右侧，低调样式（灰色小字），避免误触

**代码位置**：`main.js` `_PREF_DEFAULTS` / `_resetPrefs()` / `bindPaneEvents()`；`index.html` 参数面板底部。

### 15. 大图预览 Ctrl+Z 支持

**背景**：原键盘事件处理在 previewModal 打开时直接 `return`，导致 Ctrl+Z 被跳过。

**方案**：在 `return` 前加入 Ctrl+Z 判断，使用 `G.previewTabId`（而非 `G.activeTabId`）确保撤回的是预览所在标签页的删除操作。

**代码位置**：`main.js` `document.addEventListener('keydown', ...)` 块。

### 16. 命令行参数支持

**方案**：在 `__main__` 块顶部用 `argparse` 解析参数，支持：
- `--port PORT`：指定端口，若端口被占用立即报错退出（而非静默切换）
- `--no-browser`：禁用自动打开浏览器，适合服务器/脚本场景

**注意**：`argparse` 在 `--noconsole` 打包的 exe 中仍然有效，用户可在命令提示符中使用。`--help` 在 `--noconsole` 模式下会弹出短暂控制台窗口后关闭，这是 PyInstaller 的已知行为，不影响功能。

**代码位置**：`app.py` `if __name__ == '__main__':` 块顶部。

### 17. `<template>` 克隆陷阱与重置按钮动态创建

**背景**：HTML `<template>` 标签在 `cloneNode(true)` 时，Tailwind CDN JIT 不扫描其内部 class，导致 utility class 无样式；inline `onclick`/`onmouseover` 等事件属性在克隆后也可能丢失。这导致放在 template 内的重置按钮既无样式也无响应。

**方案**：
- 从 template HTML 中移除重置按钮
- 在 `bindPaneEvents()` 中用 `document.createElement('button')` 动态创建按钮
- 样式通过 `btn.style.cssText` 内联设置 + `style.css` 中的 `.btn-reset` class 双保险
- 事件通过 `btn.addEventListener('click', ...)` 直接绑定，不依赖 template 克隆

**教训**：`<template>` 内的元素不要依赖 Tailwind CDN 动态生成的 class，也不要依赖 inline 事件属性。需要交互的元素优先用 JS 动态创建。

**代码位置**：`main.js` `bindPaneEvents()` 末尾；`style.css` `.btn-reset`。

### 18. 默认值一致性修复

**背景**：`enable_history` 后端默认值为 `False`，与前端默认 `True`（checkbox checked）不一致；`speed_mode` 后端默认 `'eco'`，前端默认 `'fast'`。

**方案**：统一所有位置的默认值：
- `enable_history` → `True`（后端 `start_extraction`、`resume`、`_extraction_worker`、会话恢复）
- `speed_mode` → `'fast'`（同上所有位置 + HTML `<select>` 加 `selected`）

**代码位置**：`app.py` 全局搜索 `enable_history` 和 `speed_mode`。

### 19. Ctrl+Z 撤销后预览跳转

**背景**：在大图预览模式下 Ctrl+Z 撤销删除后，预览图片和计数器不会更新，用户需要手动切换才能看到恢复的图片。

**方案**：在 `undoLastDelete()` 末尾检测是否处于预览模式（`G.previewTabId === sid`），如果是则调用 `showPreview(sid, restoredIdx)` 跳转到恢复的图片位置。

**代码位置**：`main.js` `undoLastDelete()`。

### 20. 安全加固

- 图片服务、下载、打包三个路由加 `os.path.basename()` 防路径穿越
- 视频路径校验从 `os.path.exists` 改为 `os.path.isfile`
- 端口文件读取改用 `with open()` 修复资源泄漏
- 静态文件引用加 `?v=0.4.1` cache buster
- Flask 加 `TEMPLATES_AUTO_RELOAD` 和 `SEND_FILE_MAX_AGE_DEFAULT=0`

### 21. 核显提示折叠

**方案**：将核显性能提示从始终可见的 `<div>` 改为 `<details>` 折叠元素，默认收起，标题"💡 核显用户性能提示（点击展开）"。非核显用户不会被干扰。

**代码位置**：`index.html` 参数面板内。

