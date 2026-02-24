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

延河课堂的录播视频需要借助浏览器插件下载到本地，推荐使用：

- [**猫抓 (cat-catch)**](https://github.com/nickyc975/cat-catch) — 开源浏览器资源嗅探插件（Chrome / Edge / Firefox）
- [**Video DownloadHelper**](https://www.downloadhelper.net/) — 老牌视频下载插件

安装插件后，打开延河课堂的录播页面，插件会自动嗅探视频地址，点击下载即可获得 `.mp4` 文件。

## 快速开始

### 方式一：下载 exe 直接使用（推荐）

1. 👉 前往 [**Releases**](../../releases) 页面，下载最新版 `VidSlide.exe`
2. 双击运行，浏览器自动打开工具页面
3. 选择视频 → 调参数 → 提取 → 整理排序 → 导出

> ⚠️ Windows 可能弹出 SmartScreen 安全提示（个人开发者没有商业签名证书），点击 **「更多信息 → 仍要运行」** 即可。

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
| 自动退出 | 关闭浏览器后 30 秒内自动退出并清理临时文件 |

## 自行打包 .exe

```bash
# 在虚拟环境中（推荐，打包体积 ~72MB）
pip install -r requirements.txt
# 运行打包脚本
build.bat
# 或手动执行
pyinstaller --onefile --icon="logo.ico" --version-file="version.txt" --add-data "templates;templates" --name "VidSlide" app.py
```

## 项目结构

```
VidSlide/
├── app.py              # Flask 后端 + 视频提取核心逻辑
├── templates/
│   └── index.html      # 前端页面
├── logo.ico            # 应用图标
├── version.txt         # exe 版本信息
├── requirements.txt    # Python 依赖
├── build.bat           # 一键打包脚本
└── start_dev.bat       # 开发模式启动
```

## 关于代码

本项目绝大部分代码由 **GitHub Copilot (Claude Opus 4.6)** AI 生成，由 [PWO-CHINA](https://github.com/PWO-CHINA) 审核、测试和维护。

## 隐私

所有处理均在本地完成，不上传任何数据。临时文件在关闭浏览器后自动清理。

## 许可证

[MIT License](LICENSE)
