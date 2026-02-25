# 影幻智提 (VidSlide)

> 从延河课堂录屏视频中，一键智能提取 PPT 幻灯片 — 告别截图，告别手动整理。

![Python](https://img.shields.io/badge/Python-3.8+-blue?logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-Web_UI-green?logo=flask)
![License](https://img.shields.io/badge/License-MIT-yellow)
![AI Generated](https://img.shields.io/badge/Code-AI_Generated-blueviolet?logo=github-copilot)

## 这是什么？

延河课堂的录播视频只能在线看，没有现成的 PPT 下载。  
**影幻智提** 帮你从下载好的桌面录屏视频中，自动识别每一页 PPT 翻页，提取出清晰的幻灯片图片，然后打包成 **PDF / PPTX / ZIP** 供你离线复习。

**30 秒上手**：下载 exe → 双击运行 → 选视频 → 点提取 → 导出 PDF，就这么简单。

> **注意：** 本工具专为**桌面录屏**（屏幕录制）设计，不适用于摄像头拍摄的教室视频。

## 前置步骤：先获取视频文件

延河课堂的录播视频需要借助浏览器插件下载到本地，**推荐使用 [猫抓 (cat-catch)](https://github.com/xifangczy/cat-catch)**（开源，支持 Chrome / Edge / Firefox）。

> 也可以使用 [Video DownloadHelper](https://www.downloadhelper.net/) 等其他视频下载插件。

### 以猫抓为例

1. 从 [猫抓 GitHub](https://github.com/xifangczy/cat-catch) 或浏览器扩展商店安装猫抓插件
2. 进入延河课堂的**录播课程页面**，刷新页面
3. 点击浏览器工具栏的猫抓图标，会嗅探到**两个视频**：
   - `video1.m3u8` — 这是**摄像头录播**（拍教室的，不需要）
   - `VGA.m3u8` — 这是**屏幕录播**（PPT 画面，我们要下载的）

   ![猫抓嗅探示例](docs/cat-catch-demo.png)

4. 点击 **VGA.m3u8** 旁边的下载按钮
5. 第一次使用猫抓下载时会弹出两个页面，**不用点击任何按钮**，等待猫抓自动完成下载
6. 下载完成后选择保存位置，确认该视频是屏幕录制画面后，即可使用本工具提取 PPT

## 快速开始

### 方式一：下载 exe 直接使用（推荐）

1. 👉 前往 [**Releases**](../../releases) 页面，下载最新版 `VidSlide.exe`
2. 双击运行，浏览器自动打开工具页面
3. 选择视频 → 调参数 → 点击「开始提取」
4. 提取完成后整理排序 → 导出 PDF / PPTX / ZIP

<details>
<summary>⚠️ <b>首次运行遇到 Windows 安全提示？点击展开解决方法</b></summary>

因为本工具是个人开源项目，没有购买商业代码签名证书（年费 $200+），所以 Windows SmartScreen 会弹出警告。**程序本身是安全的**，源码完全公开可审查。

**绕过方法（只需一次）：**
1. 下载 exe 后，Windows 可能提示"已阻止下载" → 点击 **保留**（或点 `···` → 保留）
2. 双击运行时弹出蓝色窗口"Windows 已保护你的电脑" → 点击 **「更多信息」** → 再点击 **「仍要运行」**
</details>

### 方式二：从源码运行

```bash
git clone https://github.com/PWO-CHINA/VidSlide.git
cd VidSlide
python -m venv venv
.\venv\Scripts\activate   # Windows
pip install -r requirements.txt
python app.py
```

## 功能一览

| 功能 | 说明 |
|------|------|
| 智能场景检测 | 基于 OpenCV 帧差分析自动识别翻页 |
| ROI 精准裁剪 | 忽略录屏工具栏和缩略图区域 |
| 动态稳定等待 | 等待动画播完再截图，消除重影 |
| 去重核验 | 自动过滤重复页面 |
| 可视化管理 | 拖拽排序、预览大图、删除/回收站 |
| 多格式导出 | PDF / PPTX / ZIP |
| 自动退出 | 浏览器断联 5 分钟后自动退出（有任务时延长等待） |
| ⚡ 快速模式 | 缩小比较分辨率至 480p 加速检测（不影响输出质量，可关闭） |
| 实时进度 | 显示百分比、已用时间、预计剩余时间 |
| 🗂️ **多标签页并行** | 同时处理最多 3 个视频，每个标签页独立运行（v0.2.0 新增） |
| 📊 **系统资源监控** | 实时显示 CPU / 内存 / GPU / 磁盘使用率及活跃任务数（v0.2.0 新增） |
| 🛡️ **安全防护机制** | 资源超限警告、独立缓存隔离、全局一键清理（v0.2.0 新增） |
| 🎮 **GPU 硬件加速** | 支持 GPU 视频解码加速（独显/核显均可），可随时切换 CPU/GPU 模式（v0.3.0 新增） |
| 📡 **SSE 实时推送** | 服务器推送替代轮询，进度更新更及时更省资源（v0.3.0 新增） |
| 🔄 **断连自动恢复** | 后端意外断开时自动重连，刷新页面即可恢复（v0.3.0 新增） |
| 🎯 **三档运行模式** | Eco 后台静默 / Fast 全速狂飙 / Turbo 极速狂暴，根据场景自由选择（v0.3.1 新增） |
| 💾 **参数配置记忆** | 自动记住上次的参数选择，下次打开无需重新设置（v0.3.1 新增） |
| 🛡️ **稳定性修复** | 弹窗互斥锁、SSE 僵尸连接防护、提取线程异常兜底（v0.3.2 新增） |

## ⚡ 三档运行模式详解

| | 🌿 Eco 后台静默 | 🚀 Fast 全速狂飙 | 💥 Turbo 极速狂暴 |
|:--|:--|:--|:--|
| **适用场景** | 边看网课边提取 | 专心等提取结果 | 赶时间，只要速度 |
| **CPU 占用** | ~30-50% | ~70-90% | ~60-80% |
| **帧跳距** | 1× (按 fps) | 1× (按 fps) | **2×** (跳帧翻倍) |
| **比较分辨率** | 480p | 480p | **320p** (更粗略) |
| **稳定帧检测** | 0.5s × 3次 | 0.5s × 3次 | **0.3s × 1次** |
| **节流间隔** | 8ms | 1ms | 1ms |
| **进程优先级** | 低于正常 | 正常 | 正常 |
| **预计提速** | 基准 | ~1.5× | **~2-3×** |
| **偶尔漏页风险** | 极低 | 极低 | 有一定概率 |

> **💡 选择建议：**
> - 不确定选啥 → **Fast**（速度与质量的最佳平衡）
> - 视频很长、只想快速浏览 → **Turbo**（漏 1-2 页可手动补）
> - 后台挂着慢慢跑 → **Eco**

## 💻 推荐设置

### 核显用户（Intel Iris Xe / AMD 集成显卡）

核显的视频解码加速效果有限，**推荐组合**：
- ✅ 运行模式：**Turbo** 或 **Fast**
- ✅ GPU 加速：**关闭**（核显解码可能反而更慢）
- ✅ 快速模式：**开启**
- ✅ 阈值：默认 30 即可，提取少了就降低，重复多了就提高

### 独显用户（NVIDIA / AMD 独立显卡）

独显硬件解码能显著降低 CPU 负担：
- ✅ 运行模式：**Fast** 或 **Turbo**
- ✅ GPU 加速：**开启**
- ✅ 快速模式：**开启**

## 自行打包 .exe

### 方式 A：Nuitka 编译（推荐，原生 C 编译，启动更快）

```bash
# 在虚拟环境中
pip install -r requirements.txt
pip install nuitka
# 运行 Nuitka 打包脚本
build_nuitka.bat
# 或手动执行（首次会自动下载 MinGW64 编译器，约 10-20 分钟）
python -m nuitka --onefile --windows-console-mode=disable --windows-icon-from-ico=logo.ico --include-data-dir=templates=templates --assume-yes-for-downloading --output-dir=dist --output-filename=VidSlide.exe app.py
```

### 方式 B：PyInstaller 打包（备选，速度快但启动稍慢）

```bash
pip install -r requirements.txt
pip install pyinstaller
# 运行 PyInstaller 打包脚本
build.bat
# 或手动执行
pyinstaller --onefile --noconsole --icon="logo.ico" --version-file="version.txt" --add-data "templates;templates" --add-data "static;static" --hidden-import extractor --hidden-import exporter --name "VidSlide" app.py
```

## 项目结构

```
VidSlide/
├── app.py              # Flask 后端（多会话 + SSE 推送 + 资源监控）
├── extractor.py        # 视频提取核心（GPU 加速 + 进程优先级调整）
├── exporter.py         # 打包导出（PDF / PPTX / ZIP）
├── templates/
│   └── index.html      # 前端页面模板
├── static/
│   ├── css/style.css   # 外部样式表
│   └── js/main.js      # 前端主逻辑（SSE + DocumentFragment）
├── logo.ico            # 应用图标
├── version.txt         # exe 版本信息
├── requirements.txt    # Python 依赖
├── build_nuitka.bat    # Nuitka 打包脚本（推荐）
├── build.bat           # PyInstaller 打包脚本（备选）
└── start_dev.bat       # 开发模式启动
```

## 常见问题

<details>
<summary><b>提取速度太慢怎么办？</b></summary>

1. 切换到 **Turbo** 或 **Fast** 模式（参数面板下拉选择）
2. 核显用户建议**关闭 GPU 加速**（核显解码可能反而拖慢速度）
3. 确保**快速模式**已开启（降低比较分辨率，不影响输出画质）
</details>

<details>
<summary><b>提取出来的页面有遗漏怎么办？</b></summary>

1. 适当**降低阈值**（默认 30，降到 20-25 提高翻页灵敏度）
2. 如果使用的是 Turbo 模式，切换到 **Fast** 模式重新提取（Turbo 跳帧较大，偶尔会漏页）
</details>

<details>
<summary><b>提取出来的页面有重复怎么办？</b></summary>

1. 适当**提高阈值**（从 30 提到 35-40）
2. 重复的页面可以在画廊中点选后删除，或在大图预览中直接删除
</details>

<details>
<summary><b>exe 打开后浏览器没有自动弹出？</b></summary>

手动在浏览器中输入 `http://127.0.0.1:5875` 即可打开。如果端口被占用，程序会自动切换到其他端口，请查看托盘或控制台提示。
</details>

<details>
<summary><b>杀毒软件报毒怎么办？</b></summary>

这是 PyInstaller 打包的通病，不是真的有病毒。可以：
1. 在杀毒软件中添加 `VidSlide.exe` 为信任/例外
2. 或从源码运行（`python app.py`），完全避免这个问题
</details>

## 关于代码

本项目绝大部分代码由 **GitHub Copilot (Claude Opus 4.6)** AI 生成，由 [PWO-CHINA](https://github.com/PWO-CHINA) 审核、测试和维护。

## 更新日志

### v0.3.2 (2026-02-25) — 稳定性修复版
- 🔒 **文件选择弹窗互斥**：多标签页同时点击「浏览选择视频」时，第二个标签页立即提示「其他标签页正在选择文件」，不再卡死超时
- 🔁 **SSE 僵尸连接防护**：前端 EventSource 连续出错 3 次后主动放弃重连，避免后端会话已清理时的无限 404 刷屏
- 🛡️ **提取线程异常兜底**：`_extraction_worker` 外层包裹全局 `try/except`，任何未知崩溃（OpenCV 崩溃、OOM 等）都会向前端推送错误状态，不再死等
- 🧹 **孤儿会话自动清理**：无活跃 SSE 连接的残留会话超时后自动回收，不再占用标签页名额
- 📊 **动态最大标签页数**：根据 CPU 核数和内存总量在启动时自动计算最大并行标签页数（最少 2，最多 8）
- 🔧 **Nuitka 打包修复**：`build_nuitka.bat` 补上漏掉的 `--include-data-dir=static=static`，修复打包后缺少静态资源的问题

### v0.3.1 (2026-02-25) — 性能狂飙版
- ⚡ **三档运行模式**：Eco 后台静默 / Fast 全速狂飙 / Turbo 极速狂暴，根据场景自由切换
  - Eco：降低优先级 + 8ms 节流，后台挂机无感
  - Fast：保持正常优先级 + 1ms 微小节流，释放全部算力
  - Turbo：在 Fast 基础上，2x 帧跳距 + 320p 超低分辨率对比 + 加速稳定帧检测，理论提速 40-50%
- 💾 **参数配置记忆**：localStorage 自动保存/恢复所有提取参数，下次打开无需重新设置
- 💡 **核显性能提示**：参数区新增智能提示，引导核显用户使用「Turbo + 关闭 GPU」极速组合
- 🗑️ **删除按钮优化**：大图预览删除按钮移至右下角，改为胶囊样式 `🗑️ 删除 (Del)`，不再被 Toast 遮挡
- 🛡️ **内存溢出防护**：每 500 帧强制 `gc.collect()`，防止 Fast/Turbo 模式下帧数组堆积导致 OOM
- 👁️ **预览导航优化**：第一张隐藏左箭头，最后一张隐藏右箭头

### v0.3.0 (2026-02-25) — 性能优化版
- 📡 **SSE 服务器推送**：用 Server-Sent Events 替代高频 HTTP 轮询，进度更新更及时、资源消耗更低
- ⚡ **异步后台打包**：PDF/PPTX/ZIP 打包在后台线程异步执行，前端通过 SSE 实时显示打包进度
- 🎮 **GPU 硬件加速**：视频解码自动检测并使用 GPU 加速，提取速度大幅提升
- 🔀 **GPU/CPU 切换开关**：参数面板新增硬件加速开关，遇到兼容性问题可随时切回 CPU 模式
- 📊 **GPU 实时监控**：资源监控栏新增 GPU 使用率、显存占用显示（支持 NVIDIA 独显 + Intel/AMD 核显，通过 Windows PDH 通配符计数器自动追踪）
- 🗑️ **大图预览内删除**：预览模式新增删除按钮，删除后自动跳转下一张，无需退出预览
- ❤️ **心跳超时优化**：超时从 20 秒提升至 5 分钟，新增 `visibilitychange` 事件防止浏览器后台节流导致误判退出
- 🛡️ **智能退出保护**：有活跃任务或未导出成果时，即使心跳超时也不会退出
- 🔄 **断连自动重连**：后端意外断开时自动每 5 秒尝试重连，恢复后自动刷新页面
- 🔌 **端口持久化**：记录上次使用的端口，刷新浏览器时自动连回同一端口
- 🔧 **进程优先级降低**：自动降低提取进程优先级，减少对前台应用的影响
- 🏗️ **代码 MVC 拆分**：拆分为 `extractor.py`（提取核心）+ `exporter.py`（打包导出）+ `app.py`（路由控制）
- 🎨 **前端代码拆分**：CSS/JS 独立为外部文件，HTML 模板更清爽
- ⚡ **DocumentFragment 优化**：画廊渲染使用 DocumentFragment 批量插入，浏览器只重绘一次

### v0.2.1 (2026-02-25)

<details>
<summary>点击展开</summary>

- 🐛 **取消提取后画廊正常显示**：修复点击「取消提取」后已提取的图片不显示在画廊的 Bug
- 🐛 **取消后 Worker 立即停止**：`cancel_flag` 检查扩展到 4 个关键位置，消除取消后 CPU 空转
- ⚡ **CPU 占用优化**：提取主循环和稳定帧子循环各加入 8ms 节流，峰值 CPU 从 99% 降至 ~70-80%
- ⚡ **资源及时释放**：Worker 退出改用 `try/finally` 统一释放 + `gc.collect()` 强制回收
- ⚡ **后台 CPU 采样**：系统资源监控改为后台线程采样，API 不再阻塞
- ⚡ **轮询降频**：自适应轮询（运行时 800ms，空闲自动停止）
- 🛡️ **鲁棒性增强**：所有 API 返回结构化错误信息 + 操作建议
- 🐛 **视频预检测**：开始提取前检测编解码器，文件损坏时给出明确提示
- 📋 **错误弹窗 + Issue 提交**：出错时弹出详情弹窗，含预填内容的「提交 Issue」快捷按钮
- 🏗️ **Nuitka 打包支持**：新增 `build_nuitka.bat`，支持 C 语言级别原生编译
</details>

### v0.2.0 (2026-02-24)

<details>
<summary>点击展开</summary>

- 🗂️ **多标签页并行处理**：支持同时打开最多 3 个标签页，每个标签页独立处理
- 📊 **系统资源监控**：实时显示 CPU / 内存 / 磁盘使用率及活跃任务数
- 🛡️ **资源安全警告**：CPU > 90% / 内存 > 85% / 磁盘剩余 < 500MB 时自动弹出警告
- 🔒 **独立会话隔离**：每个标签页拥有独立缓存目录
- 🧹 **全局一键清理**：一键关闭所有会话并清理临时文件
- 🏗️ **后端多会话架构**：重构为 UUID-based 多会话系统
</details>

### v0.1.x (2026-02-24)

<details>
<summary>点击展开</summary>

- **v0.1.2**：修复刷新崩溃、断连友好提示、心跳超时优化
- **v0.1.1**：`grab()` 顺序跳帧 3-10 倍提速、进度估算、快速模式、无控制台窗口
- **v0.1.0**：首个公开测试版
</details>

## 隐私

所有处理均在本地完成，不上传任何数据。临时文件在关闭浏览器后自动清理。

## 许可证

[MIT License](LICENSE)
