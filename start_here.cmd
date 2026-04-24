@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\helm-launch.ps1" bootstrap %*
exit /b %errorlevel%
