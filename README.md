# 影幻智提 (VidSlide)

> 从延河课堂录屏视频中，一键智能提取 PPT 幻灯片。

![Python](https://img.shields.io/badge/Python-3.8+-blue?logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-Web_UI-green?logo=flask)
![License](https://img.shields.io/badge/License-MIT-yellow)
![AI Generated](https://img.shields.io/badge/Code-AI_Generated-blueviolet?logo=github-copilot)

## 这是什么？

延河课堂的录播视频只能在线看，没有现成的 PPT 下载。
**影幻智提** 帮你从下载好的桌面录屏视频中，自动识别每一页 PPT 翻页，提取出清晰的幻灯片图片，然后打包成 PDF / PPTX / ZIP 供你离线复习。

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

> ⚠️ **重要提示：** v0.1.0 和 v0.1.1 存在刷新页面导致后端进程退出的 Bug（显示"网络连接错误"），请升级到 **v0.2.0** 或更新版本。

### 方式一：下载 exe 直接使用（推荐）

1. 👉 前往 [**Releases**](../../releases) 页面，下载最新版 `VidSlide.exe`
2. 双击运行，浏览器自动打开工具页面
3. 选择视频 → 调参数 → 提取 → 整理排序 → 导出

> **⚠️ 首次运行会遇到 Windows 安全提示，这是正常的！**
>
> 因为本工具是个人开源项目，没有购买商业代码签名证书（年费 $200+），所以 Windows SmartScreen 会弹出警告。**程序本身是安全的**，源码完全公开可审查。
>
> **绕过方法：**
> 1. 下载 exe 后，Windows 可能提示"已阻止下载" → 点击 **保留**（或点 `···` → 保留）
> 2. 双击运行时弹出蓝色窗口"Windows 已保护你的电脑" → 点击 **「更多信息」** → 再点击 **「仍要运行」**
>
> 这两步只需要做一次，之后不会再弹出。

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
| 自动退出 | 关闭浏览器后 20 秒内自动退出并清理临时文件 |
| ⚡ 快速模式 | 缩小比较分辨率至 480p 加速检测（不影响输出质量，可关闭） |
| 实时进度 | 显示百分比、已用时间、预计剩余时间 |
| 🗂️ **多标签页并行** | 同时处理最多 3 个视频，每个标签页独立运行（v0.2.0 新增） |
| 📊 **系统资源监控** | 实时显示 CPU / 内存 / 磁盘使用率及活跃任务数（v0.2.0 新增） |
| 🛡️ **安全防护机制** | 资源超限警告、独立缓存隔离、全局一键清理（v0.2.0 新增） |

## 自行打包 .exe

```bash
# 在虚拟环境中（推荐，打包体积 ~72MB）
pip install -r requirements.txt
# 运行打包脚本
build.bat
# 或手动执行
pyinstaller --onefile --noconsole --icon="logo.ico" --version-file="version.txt" --add-data "templates;templates" --name "VidSlide" app.py
```

## 项目结构

```
VidSlide/
├── app.py              # Flask 后端（多会话架构 + 资源监控）
├── templates/
│   └── index.html      # 前端页面（标签页系统 + 资源仪表盘）
├── logo.ico            # 应用图标
├── version.txt         # exe 版本信息
├── requirements.txt    # Python 依赖（含 psutil）
├── build.bat           # 一键打包脚本
└── start_dev.bat       # 开发模式启动
```

## 关于代码

本项目绝大部分代码由 **GitHub Copilot (Claude Opus 4.6)** AI 生成，由 [PWO-CHINA](https://github.com/PWO-CHINA) 审核、测试和维护。

## 更新日志

### v0.2.0 (2026-02-24)
- 🗂️ **多标签页并行处理**：支持同时打开最多 3 个标签页，每个标签页独立处理一个视频，真并行互不干扰
- 📊 **系统资源监控**：顶栏实时显示 CPU / 内存 / 磁盘使用率及当前活跃任务数，每 3 秒刷新
- 🛡️ **资源安全警告**：CPU > 90% / 内存 > 85% / 磁盘剩余 < 500MB 时自动弹出警告，防止系统卡死
- 🔒 **独立会话隔离**：每个标签页拥有独立缓存目录（`.vidslide_sessions/{sid}/`），互不污染
- 🧹 **全局一键清理**：Header 区提供「清理全部」按钮，一键关闭所有会话并清理临时文件
- 🏗️ **后端多会话架构**：重构为 UUID-based 多会话系统，线程安全，支持并发提取
- ➕ **新增依赖**：`psutil` 用于系统资源监控
- 🔧 **空闲轮询优化**：空闲会话自动停止进度轮询，降低不必要的 HTTP 请求

### v0.1.2 (2026-02-24)
- 🐛 **修复刷新崩溃**：刷新页面不再导致后端进程退出（原因：`pagehide` 事件错误发送了 shutdown 信号）
- 🔌 **断连友好提示**：后端意外退出时显示全屏提示（引导重启 + Issue 反馈链接），不再只显示"网络错误"
- ❤️ **心跳超时优化**：关闭 tab 后 20s 自动退出（原 30s）
- 📚 **文档更新**：添加猫抓详细使用教程和截图

### v0.1.1 (2026-02-24)
- ⚠️ **已知问题：刷新页面会导致后端退出，请升级到 v0.1.2**
- ⚡ **性能优化**：用 `grab()` 顺序跳帧代替 `set(POS_FRAMES)` 随机 seek，处理速度提升 3-10 倍
- 📊 **进度估算**：进度条显示已用时间 + 预计剩余时间
- 🔧 **快速模式**：可选将比较分辨率降至 480p 进一步加速（默认开启，不影响输出质量）
- 🚫 **无控制台窗口**：双击 exe 后纯后台运行，不再弹出黑色命令行

### v0.1.0 (2026-02-24)
- ⚠️ **已知问题：刷新页面会导致后端退出，请升级到 v0.1.2**
- 🎉 首个公开测试版

## 隐私

所有处理均在本地完成，不上传任何数据。临时文件在关闭浏览器后自动清理。

## 许可证

[MIT License](LICENSE)
