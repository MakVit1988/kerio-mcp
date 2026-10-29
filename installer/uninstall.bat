@echo off
setlocal
chcp 65001 >nul
title Kerio mail for Claude - uninstall
set "HERE=%~dp0"
set "TMPNODE=%TEMP%\kerio-uninstall-node.exe"
rem Run from a copy of node.exe: the installed one cannot be deleted while it is running.
copy /y "%HERE%node\node.exe" "%TMPNODE%" >nul
"%TMPNODE%" "%HERE%app\installer\setup.js" --uninstall --install-dir "%HERE:~0,-1%"
del "%TMPNODE%" >nul 2>&1
echo.
pause
