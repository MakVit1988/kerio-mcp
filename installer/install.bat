@echo off
setlocal
chcp 65001 >nul
title Kerio mail for Claude - installation
cd /d "%~dp0"

rem Use Node.js 18+ if it is installed, otherwise download a private node.exe (checked by SHA-256).
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if defined NODE (
  "%NODE%" -e "process.exit(parseInt(process.versions.node)>=18?0:1)" || set "NODE="
)
if not defined NODE (
  echo Node.js 18 or newer was not found. Downloading node.exe, please wait...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\installer\get-node.ps1" -OutFile "%TEMP%\kerio-setup-node.exe"
  if errorlevel 1 (
    echo Could not download node.exe. Check the internet connection and run install.bat again.
    pause
    exit /b 1
  )
  set "NODE=%TEMP%\kerio-setup-node.exe"
)

"%NODE%" "%~dp0app\installer\setup.js" %*
set "RESULT=%ERRORLEVEL%"
if exist "%TEMP%\kerio-setup-node.exe" del "%TEMP%\kerio-setup-node.exe" >nul 2>&1
echo.
pause
exit /b %RESULT%
