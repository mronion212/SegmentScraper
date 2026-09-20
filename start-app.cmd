@echo off
cd /d "%~dp0"
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
) else (
  echo Installeer eerst de desktopafhankelijkheden met npm install, of open de gebouwde EXE in dist.
  pause
)
