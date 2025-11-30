@echo off
setlocal
for /f "usebackq tokens=* delims=" %%i in (`wsl wslpath "%~dp0"`) do set WSL_DIR=%%i
wsl -e bash -lc "netstat -tlnp | grep -E ':(5176|8003) ' | awk '{print $7}' | cut -d/ -f1 | xargs -r kill -9"
wsl -e bash -lc "cd '%WSL_DIR%modern-app' && npm run dev:full"
timeout /t 4 >nul
start "" http://localhost:5176
endlocal
