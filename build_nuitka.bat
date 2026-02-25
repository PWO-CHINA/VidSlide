@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
echo.
echo ============================================
echo   影幻智提 (VidSlide) - Nuitka 打包脚本
echo   C 语言级别原生编译，启动更快
echo ============================================
echo.

REM 检查是否在虚拟环境中
if not defined VIRTUAL_ENV (
    echo [警告] 未检测到虚拟环境！
    echo 强烈建议在虚拟环境中打包，否则 .exe 体积可能非常大。
    echo.
    echo 创建虚拟环境的步骤：
    echo   python -m venv venv
    echo   .\venv\Scripts\activate
    echo   pip install -r requirements.txt
    echo.
    set /p CONTINUE="是否继续打包？(y/n): "
    if /i not "!CONTINUE!"=="y" (
        echo 已取消。
        pause
        exit /b
    )
)

echo [1/3] 正在检查 Nuitka...
pip show nuitka >nul 2>&1
if errorlevel 1 (
    echo [INFO] 正在安装 Nuitka...
    pip install nuitka
    if errorlevel 1 (
        echo [错误] Nuitka 安装失败，请检查网络连接。
        pause
        exit /b 1
    )
)

echo [2/3] 正在检查项目依赖...
pip show flask >nul 2>&1
if errorlevel 1 (
    echo [INFO] 正在安装项目依赖...
    pip install -r requirements.txt
)

echo [3/3] 正在使用 Nuitka 编译为原生 .exe ...
echo.
echo   ⚠ 首次编译时 Nuitka 会自动下载 MinGW64 编译器、ccache 等工具。
echo   ⚠ 编译过程可能需要 10~20 分钟，CPU 占用会很高，请耐心等待。
echo.

REM 修复 Windows Store Python 缓存路径问题
if not defined NUITKA_CACHE_DIR (
    set "NUITKA_CACHE_DIR=%USERPROFILE%\NuitkaCache"
)

python -m nuitka ^
    --onefile ^
    --windows-console-mode=disable ^
    --windows-icon-from-ico=logo.ico ^
    --include-data-dir=templates=templates ^
    --include-data-dir=static=static ^
    --enable-plugin=tk-inter ^
    --assume-yes-for-downloads ^
    --output-dir=dist ^
    --output-filename=VidSlide.exe ^
    --remove-output ^
    --product-name="VidSlide" ^
    --product-version="0.4.0" ^
    --file-description="VidSlide PPT Extractor" ^
    --copyright="Copyright 2026 PWO-CHINA" ^
    app.py

echo.
if exist "dist\VidSlide.exe" (
    echo ============================================
    echo   ✅ Nuitka 编译成功！
    echo   输出文件: dist\VidSlide.exe
    echo ============================================
    echo.
    echo 你可以把 dist\VidSlide.exe 发给同学，双击即可使用。
    echo 相比 PyInstaller，Nuitka 编译的 exe 启动更快，不易被杀毒软件误报。
) else (
    echo [错误] 编译失败，请检查上方的错误日志。
    echo 常见问题：
    echo   1. 首次编译需要下载编译器，确保网络通畅
    echo   2. 如果卡在下载，可手动下载 MinGW64 并配置环境变量
    echo   3. 确保 Python 版本 ^>= 3.8
)

echo.
pause
