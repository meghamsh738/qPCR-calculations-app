@echo off
setlocal
set "WSL_PATH='/mnt/d/coding projects/qpcr-calculations-app-git/modern-app'"
start "qPCR calc servers" wsl -e bash -lc "cd %WSL_PATH% && npm run dev:full"
timeout /t 4 >nul
start "" http://localhost:5176
endlocal
