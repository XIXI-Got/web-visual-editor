@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  网页修改器 / 视觉编辑器 - 全部测试
echo  core/api + 宿主 + 渲染端 + 撤销分支 + 工作台
echo ============================================
node tools\visual-editor\e2e\run-all.mjs
echo.
echo 退出码：%ERRORLEVEL%
pause
