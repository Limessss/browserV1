@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo [Ant Browser Desktop] starting electron-vite dev...
call npm run dev
pause
