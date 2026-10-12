@echo off
rem Install 1C skills for OpenCode. Double-click this file.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" %*
echo.
pause
