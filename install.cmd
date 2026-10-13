@echo off
rem Agent 1C for OpenCode v2: double-click to install (parameters are passed through, e.g. install.cmd -Project D:\1c\proj)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
