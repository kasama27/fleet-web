@echo off
rem One-click launcher: start Node server + cloudflared tunnel (start-all.ps1).
rem tunnel.ps1 opens the dashboard in the browser by itself once the tunnel URL is up.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
if errorlevel 1 (
    echo.
    echo Start failed - see message above.
    pause
    exit /b 1
)
