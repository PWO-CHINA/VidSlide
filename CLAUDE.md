# VidSlide — Claude Code 项目上下文

> 每次对话开始时自动加载。开始大型任务前请先阅读 `DEVNOTES.md`（顶部有 QUICK REFERENCE，无需通读全文）。

## 项目速览

- **定位**：从桌面录屏视频中提取 PPT 幻灯片的本地单机工具
- **版本**：后端 v0.5.3 + 前端 v0.6.0
- **架构**：Python Flask（dev server，不可换 waitress）+ 原生 HTML/JS（无框架、无构建）
- **运行**：`python app.py`，浏览器自动打开

## 关键文件

| 文件 | 职责 |
|------|------|
| `app.py` | 路由 + 会话 + SSE + GPU 监控 |
| `batch_manager.py` | 批量队列状态机（独立于标签页会话） |
| `extractor.py` / `exporter.py` | 提取核心 / 打包导出 |
| `static/js/main.js` | 标签页前端 + 全局工具函数（`api` / `showToast` / `refreshIcons`）+ `G` 对象 |
| `static/js/batch/*.js` | 批量前端（8 模块），共享 `main.js` 全局作用域 |
| `static/css/style.css` | CSS 变量 + 组件样式（品牌色 `#7394b8`） |
| `templates/index.html` | 单页模板（Tailwind CDN + Lucide CDN） |

## 必须记住的规则

1. 动态 `innerHTML` 含 `data-lucide` → 赋值后**必须**调 `refreshIcons(container)`
2. `<template>` cloneNode → **必须**调 `refreshIcons(pane)`；template 内避免 Tailwind 动态 class 和 inline onclick
3. **禁止 innerHTML 重建含 Lucide 图标的按钮**（会销毁已初始化 SVG）
4. CSS 样式只能用 hex 值，Tailwind CDN 不注入自定义 CSS 变量
5. `batch/*.js` 函数全部是全局变量，命名冲突会静默覆盖 `main.js`

## 开始任务前

1. 阅读 `DEVNOTES.md` 顶部 QUICK REFERENCE 和任务类型导读表
2. 按导读表只读必要的源文件，避免浪费上下文
3. 大功能开发参考 `PPT提取工具集/` 目录下的任务文档（用户通常会提供）
