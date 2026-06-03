@echo off
REM Atalho pra abrir o PostMaster em modo dev (sem precisar npm/PATH global)
REM ELECTRON_RUN_AS_NODE precisa estar UNSET — npm scripts setam isso e quebram o app
SET ELECTRON_RUN_AS_NODE=
SET PATH=%LOCALAPPDATA%\nodejs;%PATH%
cd /d "%~dp0"
start "" ".\node_modules\electron\dist\electron.exe" .
