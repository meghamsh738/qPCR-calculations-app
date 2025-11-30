@echo off
setlocal
set "WSL_PATH='<PROJECTS_DIR>/qpcr-calculations-app-git/modern-app'"
start "qPCR calc servers" wsl -e bash -lc "cd %WSL_PATH% && npm run dev:full"
timeout /t 4 >nul
start "" http://localhost:5176
endlocal
