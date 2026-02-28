@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
echo.
echo ============================================
echo   影幻智提 (VidSlide) - 一键打包脚本
echo ============================================
echo.

REM 从 version.txt 自动提取版本号
set VERSION=unknown
for /f %%v in ('python -c "import re; m=re.search(r\"FileVersion.*?'([\\d.]+)\",open('version.txt').read()); print(m.group(1) if m else 'unknown')"') do set VERSION=%%v
echo [INFO] 当前版本: v%VERSION%
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

echo [1/2] 正在检查依赖...
pip show pyinstaller >nul 2>&1
if errorlevel 1 (
    echo [INFO] 正在安装 PyInstaller...
    pip install pyinstaller
)

echo [2/2] 正在打包为 .exe（这可能需要 1~3 分钟）...
echo.

pyinstaller --onefile --noconsole ^
    --icon="logo.ico" ^
    --version-file="version.txt" ^
    --add-data "templates;templates" ^
    --add-data "static;static" ^
    --hidden-import extractor ^
    --hidden-import exporter ^
    --hidden-import batch_manager ^
    --hidden-import av ^
    --collect-all av ^
    --name "VidSlide" ^
    app.py

echo.
if exist "dist\VidSlide.exe" (
    REM 自动重命名为带版本号的文件名
    set FINAL_NAME=VidSlide_v%VERSION%.exe
    if exist "dist\!FINAL_NAME!" del "dist\!FINAL_NAME!"
    rename "dist\VidSlide.exe" "!FINAL_NAME!"
    echo ============================================
    echo   打包成功！
    echo   输出文件: dist\!FINAL_NAME!
    echo ============================================
    echo.
    echo 你可以把 dist\!FINAL_NAME! 拷贝给同学，双击即可使用。
) else (
    echo [错误] 打包失败，请检查上方的错误日志。
)

echo.
endlocal
pause
