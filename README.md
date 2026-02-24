# 幻影智提 (VidSlide)

> 从录播视频中一键智能提取 PPT 幻灯片，拖拽排序，打包导出为 PDF / PPTX / ZIP。

![Python](https://img.shields.io/badge/Python-3.8+-blue?logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-Web_UI-green?logo=flask)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ 功能特性

- **智能场景检测** — 基于 OpenCV 帧差分析，自动识别 PPT 翻页
- **ROI 精准裁剪** — 忽略录屏工具栏和缩略图区域，只关注 PPT 主画面
- **动态稳定等待** — 智能等待动画播放完成，消除重影和过渡帧
- **终极去重核验** — 自动过滤重复页面，支持历史记忆池防跳页重复
- **可视化管理** — 浏览器 UI 拖拽排序、预览大图、删除/回收站
- **多格式导出** — 一键打包为 PDF、PPTX 或 ZIP
- **双击即用** — 打包为单文件 `.exe`，无需安装 Python 环境

## 🚀 快速开始

### 方式一：直接使用 .exe（推荐）

1. 前往 [Releases](../../releases) 页面下载最新版 `VidSlide.exe`
2. 双击运行，浏览器会自动打开工具页面
3. 选择视频文件 → 调整参数 → 开始提取 → 整理导出

> ⚠️ Windows 可能弹出 SmartScreen 安全提示（个人开发者没有商业代码签名证书），点击 **「更多信息 → 仍要运行」** 即可。源码完全公开，可放心使用。

### 方式二：从源码运行

```bash
# 克隆仓库
git clone https://github.com/PWO-CHINA/VidSlide.git
cd VidSlide

# 创建虚拟环境（推荐）
python -m venv venv
.\venv\Scripts\activate   # Windows

# 安装依赖
pip install -r requirements.txt

# 启动
python app.py
```

## 📦 自行打包 .exe

```bash
# 在虚拟环境中
pip install -r requirements.txt

# 一键打包（或直接双击 build.bat）
pyinstaller --onefile --icon="logo.ico" --version-file="version.txt" --add-data "templates;templates" --name "VidSlide" app.py
```

打包完成后，`dist/VidSlide.exe` 就是可分发的单文件程序。

## 📁 项目结构

```
VidSlide/
├── app.py              # Flask 后端 + 视频提取核心逻辑
├── templates/
│   └── index.html      # 前端页面（Tailwind CSS + Vanilla JS）
├── logo.ico            # 应用图标
├── version.txt         # exe 版本信息（右键属性可见）
├── requirements.txt    # Python 依赖清单
├── build.bat           # Windows 一键打包脚本
├── start_dev.bat       # 开发模式启动脚本
└── .gitignore
```

## ⚙️ 使用指南

| 步骤 | 说明 |
|------|------|
| 1. 选择视频 | 点击「浏览选择」或粘贴视频路径 |
| 2. 调参数 | 灵敏度（阈值越小越敏感）、ROI 裁剪、历史记忆池 |
| 3. 提取 | 点击「开始提取」，等待进度条完成 |
| 4. 管理 | 拖拽排序、删除多余页、预览大图、Ctrl+Z 撤销 |
| 5. 导出 | 选择 PDF / PPTX / ZIP 下载 |

## 🔒 隐私说明

- 所有处理均在本地完成，不上传任何数据
- 临时文件保存在 exe 同目录下的 `.temp_cache` 和 `.temp_packages`
- 关闭浏览器页面后，服务自动退出并清理所有临时文件

## 📝 许可证

[MIT License](LICENSE) — 随意使用、修改、分发。

## 🙏 致谢

- [OpenCV](https://opencv.org/) — 计算机视觉核心
- [Flask](https://flask.palletsprojects.com/) — Web 框架
- [Tailwind CSS](https://tailwindcss.com/) — 前端样式
- [SortableJS](https://sortablejs.github.io/Sortable/) — 拖拽排序
- [python-pptx](https://python-pptx.readthedocs.io/) — PPTX 生成

---

**Made with ❤️ by [PWO-CHINA](https://github.com/PWO-CHINA)**
