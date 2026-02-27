# VidSlide 开发者备忘录

> 给接手的 AI（和人类开发者）的非公开技术笔记。
> 记录了代码中不明显的设计决策、踩过的坑和注意事项。

> **给接手 AI 的第一句话**：请先阅读 DEVNOTES.md 了解项目架构和历史问题。
> 项目根目录下 `.\venv` 是现有虚拟环境，`requirements.txt` 是依赖清单。
> 所有改动都已提交推送，可通过 `git log` 追溯设计演变。

---

## ⚡ QUICK REFERENCE（AI 快速定向，每次大任务先读这里）

**项目状态**：后端 v0.5.3 三区域架构 + 前端 v0.6.0 视觉重构 | Flask 本地服务 + 原生 JS（无框架、无构建步骤）

**关键文件速查**：

| 文件 | 一句话职责 |
|------|-----------|
| `app.py` | 路由 + 会话 + SSE + GPU 监控（148-280 行最复杂，改前务必读 §1） |
| `batch_manager.py` | 批量队列状态机（完全独立于标签页会话系统） |
| `extractor.py` | 帧差检测核心（三档速度模式） |
| `exporter.py` | PDF / PPTX / ZIP 打包 |
| `static/js/main.js` | 标签页前端核心 + 全局工具函数（`api` / `showToast` / `refreshIcons`）+ `G` 对象 |
| `static/js/batch/*.js` | 批量前端（8 个模块），共享 `main.js` 全局作用域 |
| `static/css/style.css` | CSS 变量 + 全部自定义组件样式 |
| `templates/index.html` | 单页 HTML，含 Tailwind CDN 配置和所有模态框 / `<template>` 标签 |

**最高优先级规则（违反即出 bug）**：

1. **Lucide 图标刷新**：动态 `innerHTML` 赋值后若含 `data-lucide` → **必须**调用 `refreshIcons(container)`
2. **`<template>` cloneNode 后**：**必须**调用 `refreshIcons(pane)`；template 内避免 Tailwind 动态 class 和 inline onclick
3. **禁止用 innerHTML 重建含 Lucide 图标的按钮**：SVG 已由页面加载时初始化，重建会销毁它；改用独立 `<span>` 更新文本
4. **CSS 只能用 hex 值**：Tailwind CDN 不自动注入自定义 CSS 变量，`var(--brand-500)` 之类在 class 里不生效；品牌色用 `#7394b8`
5. **SSE 依赖 Flask dev server**：不能换 waitress（waitress 会缓冲 streaming response，直接破坏 SSE）
6. **批量模块共享全局作用域**：`batch/*.js` 的函数全部暴露为全局变量，命名与 `main.js` 冲突会静默覆盖

**任务类型导读**：

| 做什么 | 主要读哪些文件 | 参考 DEVNOTES 章节 |
|--------|--------------|------------------|
| 标签页模式 UI / 逻辑 | `main.js`, `index.html`, `style.css` | §3 配置记忆, §17 template 陷阱 |
| 批量处理逻辑 / 新功能 | `batch_manager.py`, `app.py` batch 路由, `batch/*.js` | §7 批量系统, §22–40 |
| 前端样式 / 新组件 | `style.css`, `index.html` | §41–43 Lucide/CSS 规范 |
| 视频提取算法 | `extractor.py` | §2 三档速度模式 |
| GPU / 资源监控 | `app.py` 148–280 行 | **§1（务必先读！）** |
| 打包 exe | `build.bat`, `version.txt` | §打包方式, §版本号更新清单 |

---

## 目录

- [⚡ QUICK REFERENCE](#-quick-reference)
- [项目概况](#项目概况)
- [核心文件职责](#核心文件职责)
- [重要设计决策 & 踩坑记录](#重要设计决策--踩坑记录)
  - [§1 GPU 监控 — Intel 核显兼容](#1-gpu-监控--intel-核显兼容)
  - [§2 三档速度模式](#2-三档速度模式)
  - [§3 前端 localStorage 配置记忆](#3-前端-localstorage-配置记忆)
  - [§4 SSE 服务器推送](#4-sse-服务器推送)
  - [§5 多会话架构](#5-多会话架构)
  - [§6 beforeunload 与关闭服务](#6-beforeunload-与关闭服务)
  - [§7 批量处理系统](#7-批量处理系统v050-新增v053-三区域重构)
- [已知问题 & 限制](#已知问题--限制)
- [打包方式](#打包方式)
- [版本号更新清单](#版本号更新清单)
- [依赖说明](#依赖说明)
- [v0.3.2 修复的逻辑漏洞](#v032-修复的逻辑漏洞)
- [给 AI 的提示](#给-ai-的提示)
- [v0.4.0 新增设计决策](#v040-新增设计决策)（§7–11）
- [v0.4.1 新增设计决策](#v041-新增设计决策)（§13–21）
- [v0.5.1 批量队列交互修复](#v051-批量队列交互修复)（§22–40）
- [v0.6.0 视觉风格重构](#v060-视觉风格重构极简毛玻璃-ai-风)（§41–44）

---

## 项目概况

- **定位**：从延河课堂桌面录屏视频中提取 PPT 幻灯片的单机工具
- **架构**：Python Flask 后端 + 原生 HTML/JS 前端（无框架），单进程多线程
- **当前版本**：v0.5.3
- **GitHub**：https://github.com/PWO-CHINA/VidSlide
- **Gitee 镜像**：https://gitee.com/pwo101/VidSlide（国内下载更快）
- **Python**：3.11（Microsoft Store 版），虚拟环境在 `./venv`

## 核心文件职责

| 文件 | 行数（约） | 职责 |
|------|-----------|------|
| `app.py` | ~2010 | Flask 路由、多会话管理、SSE 推送、GPU 监控、批量 API 路由（26+） |
| `batch_manager.py` | ~2050 | 批量队列调度（三区域模型）、并发 worker、缩略图、智能命名、持久化、打包导出 |
| `extractor.py` | ~295 | 视频帧差检测核心、场景切换识别、三档速度模式 |
| `exporter.py` | ~150 | PDF/PPTX/ZIP 导出 |
| `templates/index.html` | ~740 | 前端 HTML 模板（Tailwind CDN），含批量三区域面板、命名弹窗、视频详情弹窗 |
| `static/js/main.js` | ~1660 | 前端核心逻辑：SSE、画廊、拖拽排序、localStorage 配置记忆 |
| `static/js/batch/core.js` | ~530 | 批量模式核心：状态模型、SSE、初始化、恢复、工具函数 |
| `static/js/batch/zones.js` | ~320 | 三区域渲染：未选中/处理队列/已完成的视频卡片 |
| `static/js/batch/select.js` | ~200 | 多选模块：有序/无序多选、Shift 范围选 |
| `static/js/batch/controls.js` | ~350 | 控制模块：开始/暂停、移入队列/移回、重试、SortableJS |
| `static/js/batch/detail.js` | ~480 | 详情页：画廊、预览、删除/撤销、图片回收站、导出 |
| `static/js/batch/naming.js` | ~190 | 命名弹窗：模板命名、自动递增 |
| `static/js/batch/export.js` | ~120 | 导出模块：单视频/批量导出、打包进度 |
| `static/js/batch/recycle.js` | ~270 | 回收站模块：视频回收站、三选项恢复、图片预览 |
| `static/css/style.css` | ~1010 | 自定义样式，含三区域模型和详情弹窗样式 |

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

### 7. 批量处理系统（v0.5.0 新增，v0.5.3 三区域重构）

**架构**：独立于标签页会话系统，`batch_manager.py` 管理批量队列，`app.py` 提供 26+ 个 `/api/batch/*` 路由。

**三区域模型（v0.5.3）**：
- **未选中区 (unselected)**：添加/扫描的视频默认落入此区，支持拖拽排序、有序多选
- **处理队列 (queue)**：用户手动移入，必须点击「开始处理」才启动调度器
- **已完成区 (completed)**：处理完成的视频自动移入，支持详情预览和导出
- **回收站 (trash)**：半处理/已完成视频的暂存区，支持三种恢复方式

**前端模块化（v0.5.3）**：原 `batch.js` 拆分为 8 个独立模块：
- `core.js` — 状态模型、SSE、初始化
- `zones.js` — 三区域卡片渲染
- `select.js` — 多选逻辑（有序/无序/Shift 范围选）
- `controls.js` — 开始/暂停、移入队列/移回、SortableJS
- `detail.js` — 详情页画廊、预览、删除/撤销、图片回收站
- `naming.js` — 命名弹窗、模板命名、自动递增
- `export.js` — 单视频/批量导出
- `recycle.js` — 视频回收站、三选项恢复

**核心设计**：
- 每个 batch 有独立的 `batch_dir`（`.vidslide_sessions/batch_{bid}/`），内含子目录按视频分组
- 并发调度：`threading.Semaphore` 控制 worker 数量（1-3），根据 CPU 核心数和内存自动计算上限
- SSE 事件推送：`queue.Queue` 队列，支持多客户端订阅，15 秒心跳保活
- 持久化：`batch.json` 保存队列元数据，重启后自动恢复（running→paused，需手动继续）
- 全局进度：按帧数加权计算，无帧数信息时按任务数平均

**前端 batch/ 模块**：
- 视图切换：标签页模式 ↔ 批量模式，共享 Header 和资源监控条
- 队列管理：SortableJS 拖拽排序、行内编辑名称、优先处理、逐个取消
- 命名弹窗：支持拖拽调整顺序、自动递增命名（`课程_1`→`课程_2`→...）
- 视频详情弹窗：画廊网格、大图预览（复用 previewModal）、单张删除、导出
- 参数记忆：`localStorage` 保存批量参数（key: `vidslide_batch_prefs`）
- 完成通知：浏览器 Notification + 标题闪烁 + Web Audio 音效
- 队列计数徽章：Header 按钮上显示当前队列数量

**智能命名递增模式**（`batch_manager.py`，按优先级匹配）：
1. `第N节/章/课/讲` — 中文序数
2. `（N）/(N)` — 括号数字
3. `xxx_N / xxx-N` — 分隔符+数字
4. 尾部纯数字 — `video01`→`video02`
5. 无匹配 — 追加 `_1, _2, ...`

**踩坑**：
- CSS 中 `var(--brand-500)` 等自定义属性在 Tailwind CDN 模式下不会自动注入为 CSS 变量，必须用实际 hex 值（v0.5.x 的 Indigo 为 `#6366f1`，v0.6.0 重构后新品牌色为 `#7394b8`）
- 批量导出 ZIP 中文件夹名用 `display_name`，需要 `_sanitize_dirname()` 处理非法字符

## 已知问题 & 限制

1. **Nuitka 编译在中文 Windows 用户名下失败**：gcc (msvcrt 变体) 的 `std::filesystem` 在中文系统 locale 下有 Illegal byte sequence bug。需要安装 VS2022 C++ 工具使用 MSVC 编译，或者继续用 PyInstaller
2. **核显 GPU 加速可能反而更慢**：核显的视频硬解码加速效果有限，对某些视频可能还不如 CPU 软解。前端有提示建议核显用户关闭 GPU 加速
3. **Windows Store Python 路径问题**：Microsoft Store 版 Python 路径含长路径，部分工具（如 typeperf）在参数过长时会报 WinError 206

## 打包方式

### PyInstaller（当前在用）
```bash
.\venv\Scripts\activate
build.bat
```
`build.bat` 会自动从 `version.txt` 提取版本号，打包后重命名为 `dist/VidSlide_v{版本号}.exe`（约 72 MB）。

**版本号自动提取机制**：`build.bat` 用 Python 单行脚本从 `version.txt` 的 `FileVersion` 字段正则提取版本号，打包完成后自动 `rename` 为 `VidSlide_v0.x.x.exe`，无需手动重命名。

### Nuitka（理论更优但有 bug，基本放弃）
中文 Windows 用户名 + gcc msvcrt 变体 = `std::filesystem` 编译失败。解决方案：
- 安装 VS2022 C++ 桌面开发工具，用 `--msvc=latest`（目前用户无法下载，其电脑各个盘内的空间都不足）
- 或等 Nuitka 修复该 bug

## 版本号更新清单

发新版时需要同步修改：
1. `version.txt` — exe 版本元数据（filevers / prodvers / FileVersion / ProductVersion）
2. `README.md` — 更新日志
3. `batch_manager.py` 头部注释的版本号
4. `static/js/batch/*.js` — 所有 8 个模块文件头部注释的版本号
5. `static/css/style.css` — 三区域模型样式注释中的版本号
6. `templates/index.html` — script 标签的 `?v=` 缓存破坏参数
7. `build_nuitka.bat` 中的 `--product-version`
8. Git tag：`git tag v0.x.x && git push origin v0.x.x`
9. GitHub / Gitee Release：通过 API 或网页创建 Release，**exe 文件需在网页端手动上传附件**

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
- 批量模式前端拆分为 `static/js/batch/*.js`（8 个模块），与 `main.js` 共享全局 `G` 对象和 `api()`/`showToast()`/`refreshIcons()` 等工具函数
- 批量后端在 `batch_manager.py`，独立于 `app.py` 的会话系统，通过 `app.py` 路由层桥接
- 所有提取逻辑在后台线程执行（标签页用 `_extraction_worker`，批量用 `_process_single_video`），通过 SSE 队列推送进度
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

## v0.5.1 批量队列交互修复

### 22. 取消/暂停/跳过按钮重构

**背景**：原设计中 queued 状态同时显示"移除"和"取消"两个按钮，功能完全重复；running 状态的"取消"按钮语义不够精确。

**方案**：
- 移除 `canCancel` 统一取消按钮，按状态精确分配：
  - `queued` + 批量未运行 → 仅显示"移除"（✕）
  - `queued` + 批量运行中 → 显示"跳过"（黄色按钮），调用 `_skipVideo()` 将状态标记为 `skipped`
  - `running` → 显示"暂停"（橙色按钮），调用 `_pauseVideo()` 复用 cancel API 中断 worker
- 后端 `cancel_video()` 新增 `skip=True` 参数，queued 视频可标记为 `skipped` 而非 `cancelled`
- 后端 `retry_video()` 新增 `cancelled` 状态支持，暂停/取消后的视频可重试
- `batch_status` SSE 事件触发 `_renderBatchQueue()` 完整重建，确保批量开始时按钮组正确切换
- `_updateTaskStatus()` 在状态变化时完整重建队列项（而非仅更新 badge/message）

**代码位置**：`batch.js` `_createVideoItem()` / `_pauseVideo()` / `_skipVideo()`；`batch_manager.py` `cancel_video()` / `retry_video()`；`app.py` `batch_cancel_video()`。

### 23. 非完成视频图片查看

**背景**：cancelled/skipped/error 状态的视频如果已有提取出的图片（`savedCount > 0`），原来无法查看。

**方案**：
- `_createVideoItem()` 中新增 `canView` 判断：`done` 或 `(savedCount > 0 && status in cancelled/skipped/error)`
- `canView` 为 true 时显示"查看"按钮
- `openBatchDetail()` 放宽 `status !== 'done'` 限制，改为检查 `canView`

**代码位置**：`batch.js` `_createVideoItem()` / `openBatchDetail()`。

### 24. 名称单击/双击冲突修复

**背景**：done 视频名称同时绑定 `onclick`（打开详情）和 `ondblclick`（重命名），但浏览器 DOM 事件中单击总是先于双击触发，导致双击重命名永远无法执行。

**方案**：
- 移除 `onclick` + `ondblclick` 双绑定和 `_nameClickHandler` 延迟方案
- 改为单击直接调用 `_startInlineEdit(this)` 进入重命名（`cursor:text`）
- 查看详情统一由"查看"按钮负责，名称不再承担查看职责

**代码位置**：`batch.js` `_createVideoItem()` 名称点击部分。

### 25. 全选/取消全选按钮合并

**背景**：批量导出区域有两个独立按钮"全选"和"取消全选"，交互冗余。

**方案**：
- HTML 合并为单个 `<button id="batchSelectToggleBtn">`，无参数调用 `selectAllBatchVideos()`
- `selectAllBatchVideos()` 无参数时自动检测当前状态并切换（全选↔取消全选）
- `_updateBatchExportSelection()` 同步更新按钮文字，确保单个 checkbox 变化时按钮文字也跟着变

**代码位置**：`batch.js` `selectAllBatchVideos()` / `_updateBatchExportSelection()`；`index.html` 批量导出区域。

### 26. 重试按钮改为"重新排队"

**背景**：原重试按钮用 🔄 emoji，语义不清晰，且用户期望的是"重新加入队列"而非简单重试。

**方案**：
- 按钮文字从 `🔄` 改为 `重新排队`，title 改为"重新加入队列"
- 后端 `retry_video()` 逻辑不变（重置状态为 queued，清理旧输出，必要时重启 dispatcher）
- 适用状态：`error`、`skipped`、`cancelled`

**代码位置**：`batch.js` `_createVideoItem()` 重试按钮行。

### 27. 打包下载自动触发

**背景**：单视频打包（ZIP/PDF/PPTX）完成后，`_onPackagingDone` 试图将下载链接插入 `.batch-video-download-links` 元素，但该元素在 `_createVideoItem` 中不存在，导致打包成功但用户看不到下载入口。批量打包同理，`_onBatchPackagingDone` 插入链接到 `#batchDownloadSection`。

**方案**：
- `_onPackagingDone` 和 `_onBatchPackagingDone` 改为创建隐藏 `<a>` 元素并自动 `.click()` 触发浏览器下载
- 不再依赖 DOM 中预置的下载链接容器

**代码位置**：`batch.js` `_onPackagingDone()` / `_onBatchPackagingDone()`。

### 28. 批量导出格式支持

**背景**：`package_batch_all()` 忽略 `fmt` 参数，始终将原始图片打包为 ZIP。用户点击"导出选中 PDF"或"导出选中 PPTX"时，得到的仍然是图片 ZIP。

**方案**：
- `fmt='zip'`：保持原逻辑，图片按视频名子文件夹打包
- `fmt='pdf'` 或 `fmt='pptx'`：先为每个视频调用 `package_images()` 生成对应格式文件，再将所有生成的 PDF/PPTX 文件打包进一个 ZIP
- 输出文件名区分格式：`批量导出_PDF_{bid}.zip` / `批量导出_PPTX_{bid}.zip` / `批量导出_ZIP_{bid}.zip`

**代码位置**：`batch_manager.py` `package_batch_all()`。

### 29. 导出文件名去除"整理版"后缀

**背景**：`exporter.py` 的 `package_images()` 在输出文件名中硬编码了 `_整理版` 后缀，用户不需要。

**方案**：移除 `_整理版`，直接用 `{video_name}.pdf` / `.pptx` / `.zip`。

**代码位置**：`exporter.py` `package_images()`。

### 30. 新完成视频自动勾选

**背景**：视频处理完成后 `_onVideoDone` 未设置 `task.selected = true`，导致全选计数不包含新完成的视频，需要手动取消全选再全选。

**方案**：`_onVideoDone` 中设置 `task.selected = true`，并调用 `_updateBatchExportSelection()` 同步更新计数和按钮文字。

**代码位置**：`batch.js` `_onVideoDone()`。

### 31. 重命名时图片数量混入名称

**背景**：`_startInlineEdit` 用 `nameEl.textContent.trim()` 获取旧名称，但 DOM 中名称后有 `<span>(16张)</span>`，`textContent` 会把它一起取出来。

**方案**：
- 从 `G.batch.tasks` 数据源获取 `task.displayName` 作为旧名称，不再依赖 DOM 文本
- 编辑完成后用 `_restoreNameEl()` 重建 innerHTML，正确分离名称和图片数量标签

**代码位置**：`batch.js` `_startInlineEdit()` / `_restoreNameEl()`。

### 32. 视频名称重复检测

**背景**：批量导出时，同名视频的图片会被放入同一个 ZIP 文件夹，导致文件覆盖。

**方案**：
- **前端添加时检测**：`confirmBatchAdd()` 在提交前检查新增名称与已有队列是否重复，重复时 toast 提示并阻止提交
- **前端重命名时检测**：`_startInlineEdit()` 的 `finish` 回调中检查新名称是否与其他视频重复，重复时 toast 提示并恢复原名
- **后端导出兜底**：`package_batch_all()` 对 `display_name` 做去重处理，重复名称自动追加 `_1`、`_2` 后缀，确保 ZIP 内文件夹/文件名不冲突

**代码位置**：`batch.js` `confirmBatchAdd()` / `_startInlineEdit()`；`batch_manager.py` `package_batch_all()`。

### 33. 导出选择计数修复

**背景**：视频移入回收站后，`_trashBatchVideo` 未调用 `_updateBatchExportSelection()`，导致"已选择 x/y 个视频"计数不更新。

**方案**：在 `_trashBatchVideo` 成功回调中追加 `_updateBatchExportSelection()` 调用。

**代码位置**：`batch.js` `_trashBatchVideo()`。

### 34. 命名弹窗视频缩略图

**背景**：命名弹窗中只有文件名文字，用户无法直观辨别视频内容。

**方案**：
- 新增 `POST /api/video-preview-thumb` API，接收视频路径，用 OpenCV 提取第 1 秒帧，缩放到 360p 宽度，返回 base64 JPEG
- `_showBatchAddModal()` 渲染列表时为每项添加 `<img class="batch-add-thumb">`（64×36px），异步调用 API 加载缩略图
- 加载失败不影响功能，图片保持灰色占位背景

**代码位置**：`app.py` `video_preview_thumb()`；`batch.js` `_showBatchAddModal()`。

### 35. 命名模板"应用"按钮 + 排序

**背景**：原"预览命名"按钮已经会填入模板名称，但语义不够明确。用户还需要按名称排序视频列表。

**方案**：
- 模板区域新增"应用"按钮（`applyTemplateNames()`），调用 `previewTemplateNames()` 后显示"已应用"提示
- 文件列表上方新增"名称 ↑"和"名称 ↓"排序按钮（`sortBatchAddList(order)`），按当前输入框中的名称进行 `localeCompare('zh')` 排序，排序后更新 `data-idx`

**代码位置**：`batch.js` `applyTemplateNames()` / `sortBatchAddList()`；`index.html` 模板区域和文件列表上方。

### 36. 命名弹窗关闭交互

**方案**：
- 弹窗右上角新增 `×` 关闭按钮
- 点击遮罩层（`modal-overlay`）关闭弹窗
- ESC 键关闭弹窗（`_batchAddModalKeyHandler`，弹窗关闭时自动移除监听）

**代码位置**：`index.html` `#batchAddModal`；`batch.js` `_showBatchAddModal()`。

### 37. 按钮浅色模式可见性修复

**背景**：`.btn-ghost` 基础样式为白色文字（为 header 设计），`.modal-content` 内的按钮未被浅色覆盖规则覆盖，导致日间模式下排序按钮不可见。

**方案**：CSS 覆盖选择器新增 `.modal-content .btn-ghost` 和对应的 dark 模式规则。

**代码位置**：`style.css` `.btn-ghost` 覆盖规则。

### 38. 全局进度条重设计

**背景**：原进度条放在页面最顶部，只显示当前处理视频的进度，未计入等待中的视频，无百分比和预计时间。

**方案**：
- 进度条从顶部移至控制栏下方（紧贴"开始处理"按钮）
- 进度计算改为前端自行统计所有视频：queued=0%、running=其进度、done/error/cancelled/skipped=100%，按任务数平均
- 新增百分比显示（`#batchProgressPct`）和 ETA 预估（`#batchProgressEta`），基于已用时间和当前进度线性推算
- 进度条样式复用标签页的 `.progress-fill`（shimmer 动画 + progressGlow 光效）
- `G.batch._startTime` 在 `startBatch()` / `resumeBatch()` 时记录

**代码位置**：`index.html` 控制栏内 `#batchGlobalStats`；`batch.js` `_updateGlobalProgress()` / `_formatDuration()`；`style.css` `.batch-global-stats`。

### 39. 批量面板视觉统一

**背景**：批量面板与标签页模式在视觉风格上存在差异（宽度、圆角、颜色硬编码、阴影等）。

**方案**：
- 面板宽度从 `max-w-7xl` 改为 `max-w-5xl`，与标签页一致
- 队列项、缩略图、输入框、弹窗列表项的 `border-radius` 统一为 `0.75rem`/`0.5rem`/`0.375rem` 三级体系
- 硬编码颜色全部替换为 CSS 变量（`var(--bg-muted)`、`var(--border)`、`var(--text-primary)` 等）
- 输入框新增 `:focus` 样式（`box-shadow: 0 0 0 3px var(--ring-brand)`）
- 迷你进度条高度从 4px 增至 6px，圆角改为 `9999px`，渐变色与全局进度条一致
- 拖拽 ghost 样式新增虚线边框，chosen 样式改用 `var(--ring-brand)` 光环
- 区域标题从 emoji 改为编号圆圈（`1` 全局参数、`2` 视频队列、`3` 批量导出），与标签页步骤风格一致

**代码位置**：`style.css` 批量面板样式区域；`index.html` 批量面板 section 标题。

### 40. 批量队列控制状态机修复

**背景**：暂停/跳过的视频点击"重新排队"后立即完成（不到 1 秒），再次开始处理时按钮显示混乱。

**根因**：
1. `retry_video()` 未重置 `task['cancel_flag']`，导致 worker 启动后 `should_cancel()` 立即返回 True
2. 暂停和取消共用 `cancelled` 状态，语义不清

**修复**：
- `retry_video()` 新增 `task['cancel_flag'] = False` 和 `task['_pause_intent'] = False` 重置
- `retry_video()` 支持 `paused` 状态，暂停的视频保留已提取图片（不清理 cache_dir）
- `cancel_video()` 新增 `pause` 参数，running 视频设置 `task['_pause_intent'] = pause`
- `_video_worker` 完成时检查 `_pause_intent`：True → `paused` 状态，False → `cancelled` 状态
- SSE 事件类型：paused 视频发送 `video_status` 而非 `video_error`
- `_new_video_task()` 新增 `'_pause_intent': False` 字段
- 前端 `_pauseVideo()` 发送 `{ pause: true }`
- 前端新增 `paused` 状态标签（"已暂停"）、按钮逻辑、CSS 样式（橙色系）

**视频状态机**：
```
queued → running → done
                → paused（用户暂停）→ queued（重新排队）
                → cancelled（用户取消）→ queued（重新排队）
                → error（异常）→ queued（重新排队）
queued → skipped（用户跳过）→ queued（重新排队）
```

**代码位置**：`batch_manager.py` `retry_video()` / `cancel_video()` / `_video_worker()` / `_new_video_task()`；`app.py` `batch_cancel_video()`；`batch.js` `_pauseVideo()` / `_createVideoItem()` / `statusLabels`；`style.css` `.status-paused` / `.batch-status-badge.paused`。

## v0.6.0 视觉风格重构（极简毛玻璃 AI 风）

### 41. Lucide SVG 图标系统

**背景**：前端大量使用 Unicode Emoji（📁 ✅ 🗑 等），跨平台渲染不一致（Windows/macOS 颜色、尺寸差异明显）。

**方案**：全面替换为 [Lucide](https://lucide.dev/) 线性 SVG 图标（v0.460.0，通过 `cdn.jsdelivr.net` 加载，国内访问较稳定）。

**关键实现细节**：
- `index.html` `<head>` 引入 Lucide CDN，`</body>` 前调用 `lucide.createIcons()` 一次性初始化所有静态 `data-lucide` 图标
- `main.js` 顶部定义 `refreshIcons(container)` 工具函数：所有动态 `innerHTML` 赋值后必须调用，传入最小容器节点以限定扫描范围
- `<template>` 内的图标无法被页面加载时的 `createIcons()` 初始化，必须在 `cloneNode()` 后调用 `refreshIcons(pane)`
- `<option>`、`confirm()` 对话框、`document.title` 中保留原始 Emoji（这些上下文不支持 HTML 渲染）
- **不要用 innerHTML 重建含图标的按钮**——重建会销毁已初始化的 SVG，再调 `refreshIcons` 存在时序风险。正确做法：保留静态 SVG，只更新计数等文本节点（例：`batchDetailRecycleBtn` 用独立 `<span id="batchDetailRecycleCount">` 显示数量）

**代码位置**：`index.html` 第 10 行（CDN）/ 末尾（createIcons）；`main.js` `refreshIcons()` 函数；`batch/*.js` 各模块动态渲染后的 `refreshIcons()` 调用。

### 42. 新调色板与 CSS 变量

**方案**：
- **Tailwind 品牌色**：自定义 `brand` 色系（冷调钛金蓝，`brand-500: #7394b8`）替代原 Indigo（`#6366f1`）；`soft.success/warning/error` 替代硬编码 Tailwind 状态色
- **CSS 变量（`:root` / `.dark`）**：`--ring-brand` 降饱和为 `rgba(115, 148, 184, 0.2)`；`.dark` 使用更深 Zinc 黑（`--bg-body: #09090b`，`--bg-card: #18181b`）
- **按钮主色**：`.btn-primary` 从 Slate 系改为 Brand 系（`bg-[#5a7a9e]` hover `#486180`）
- **强制颜色点**：`accent-color`（checkbox/range 系统样式）从 `#6366f1` 改为 `#7394b8`

**代码位置**：`index.html` Tailwind config；`static/css/style.css` `:root` / `.dark` 变量块。

### 43. 毛玻璃面板与现代 AI 组件

**新增 CSS 类**：
| 类名 | 用途 |
|------|------|
| `.glass-header` | 页眉深色毛玻璃（`rgba(30,41,59,0.75)` + `blur(16px) saturate(1.3)`） |
| `.glass-panel` | 通用浅色毛玻璃面板（`rgba(255,255,255,0.8)` + `blur(16px)`） |
| `.ai-switch` | iOS 风格 checkbox 开关（`appearance:none` + `::after` 伪元素滑块） |
| `.progress-track` / `.progress-fill` | 6px 高进度条 + 双色渐变 shimmer 动画（`@keyframes shimmer`） |
| `.range-input` / `.ai-range` | 细线滑块（4px 轨道 + 16px 圆形 thumb） |

**踩坑**：
- `backdrop-filter` 在某些集成显卡驱动下可能影响性能，保守使用 `blur(16px)` 而非更大值；必要时可加 `@media (prefers-reduced-motion)` 降级
- `.ai-switch` 的 `::after` 伪元素需要 `appearance: none` 先行，Chrome/Firefox/Edge 均支持，IE 不支持（本项目无需兼容）

**代码位置**：`static/css/style.css` 各 class；`index.html` `<header class="glass-header">`；表单 checkbox 加 `class="ai-switch"`，range 加 `class="range-input"`。

### 44. favicon 替换

**方案**：移除原内联 SVG Emoji `data:` URI，改用 `static/favicon.svg`（项目自定义图标），`<link rel="icon" type="image/svg+xml" href="/static/favicon.svg">`。

**注意**：`static/favicon.svg` 是较大的矢量文件（~95KB），不适合内联到 HTML。打包时已通过 `--add-data "static;static"` 一并打入 exe。

