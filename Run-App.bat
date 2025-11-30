@echo off
setlocal
for /f "usebackq tokens=*" %%i in (`wsl wslpath "%~dp0"`) do set WSL_DIR=%%i
start "qPCR calc servers" wsl -e bash -lc "cd \"%WSL_DIR%modern-app\" && npm run dev:full"
timeout /t 4 >nul
start "" http://localhost:5176
endlocal
