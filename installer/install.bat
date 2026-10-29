@echo off
setlocal
chcp 65001 >nul
title Kerio mail for Claude - installation
cd /d "%~dp0"

rem Two layouts are supported:
rem  1. the ready package (kerio-mcp-installer.zip): install.bat next to the "app" folder;
rem  2. the source code: this file lives in the "installer" folder of the repository.
set "SETUP=%~dp0app\installer\setup.js"
set "SOURCE="
if not exist "%SETUP%" (
  if exist "%~dp0setup.js" if exist "%~dp0..\server.js" (
    set "SETUP=%~dp0setup.js"
    set "SOURCE=1"
  )
)
if not exist "%SETUP%" (
  echo This is not the installer package.
  echo Download kerio-mcp-installer.zip from the Releases page of the repository ^(section Assets^),
  echo unzip it and run install.bat from the unzipped folder.
  pause
  exit /b 1
)

rem Use Node.js 18+ if it is installed, otherwise download a private node.exe (checked by SHA-256).
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if defined NODE (
  "%NODE%" -e "process.exit(parseInt(process.versions.node)>=18?0:1)" || set "NODE="
)

if defined SOURCE (
  if not defined NODE (
    echo Installing from the source code needs Node.js 18 or newer: https://nodejs.org
    echo Or download the ready package kerio-mcp-installer.zip from the Releases page.
    pause
    exit /b 1
  )
  if not exist "%~dp0..\node_modules\@modelcontextprotocol" (
    echo Source code detected. Installing components, please wait...
    pushd "%~dp0.."
    call npm ci --omit=dev --no-audit --no-fund
    if errorlevel 1 (
      popd
      echo Could not install components. Download the ready package kerio-mcp-installer.zip instead.
      pause
      exit /b 1
    )
    popd
  )
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

"%NODE%" "%SETUP%" %*
set "RESULT=%ERRORLEVEL%"
if exist "%TEMP%\kerio-setup-node.exe" del "%TEMP%\kerio-setup-node.exe" >nul 2>&1
echo.
pause
exit /b %RESULT%
