@echo off
setlocal enabledelayedexpansion
title AgentShield Setup

echo ========================================================
echo                 AgentShield Setup
echo    Protects company data in ChatGPT and other AI tools
echo ========================================================
echo.
echo After setup you activate AgentShield once by pasting an activation code
echo from the AgentShield dashboard (sign in or create an account, then
echo My activation, Generate activation code). No password is entered here.
echo.

set "TARGET_DIR=%LOCALAPPDATA%\AgentShield\extension"

set "SOURCE_DIR="
if exist "%~dp0extension\manifest.json" set "SOURCE_DIR=%~dp0extension"
if not defined SOURCE_DIR if exist "%~dp0..\extension\manifest.json" set "SOURCE_DIR=%~dp0..\extension"
if not defined SOURCE_DIR (
    echo [ERROR] The "extension" folder was not found next to this file.
    pause
    exit /b 1
)
if not exist "%SOURCE_DIR%\dist\background\service-worker.js" (
    echo [ERROR] The extension has not been built. Run "node build.js" in the extension folder first.
    pause
    exit /b 1
)

set "SERVER_URL="
set /p SERVER_URL="AgentShield server address from IT (optional, press Enter to skip): "
if defined SERVER_URL set "SERVER_URL=!SERVER_URL:"=!"
if defined SERVER_URL set "SERVER_URL=!SERVER_URL: =!"
if defined SERVER_URL if "!SERVER_URL:~-1!"=="/" set "SERVER_URL=!SERVER_URL:~0,-1!"
set "SERVER_OK=1"
if defined SERVER_URL if /i not "!SERVER_URL:~0,8!"=="https://" if /i not "!SERVER_URL:~0,7!"=="http://" set "SERVER_OK="
if not defined SERVER_OK (
    echo [ERROR] The server address must start with https://
    pause
    exit /b 1
)

echo.
echo [1/3] Copying AgentShield to %TARGET_DIR%
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
robocopy "%SOURCE_DIR%" "%TARGET_DIR%" /E /XD node_modules tests _metadata /XF client-config.json package.json package-lock.json tsconfig.json rules.json *.ts /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo [ERROR] Copy failed.
    pause
    exit /b 1
)

rem client-config.json holds only the server address (no key). An old one from an earlier
rem version (with an enrollment code) is removed.
if exist "%TARGET_DIR%\client-config.json" del /f /q "%TARGET_DIR%\client-config.json"
if defined SERVER_URL (
    echo [2/3] Saving the server address
    (
      echo {
      echo   "apiUrl": "!SERVER_URL!"
      echo }
    ) > "%TARGET_DIR%\client-config.json"
) else (
    echo [2/3] No server address entered; it comes from your activation code
)

echo [3/3] Opening the browser extensions page
start "" "%TARGET_DIR%"
set "BROWSER_BIN="
set "EXT_PAGE=chrome://extensions"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER_BIN=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_BIN if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER_BIN=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_BIN if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER_BIN=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_BIN if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_BIN=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    set "EXT_PAGE=edge://extensions"
)
if defined BROWSER_BIN start "" "!BROWSER_BIN!" "!EXT_PAGE!"

echo.
echo ========================================================
echo  Last steps (one time, about a minute):
echo   1. On the Extensions page, turn ON "Developer mode" (top right)
echo   2. Click "Load unpacked"
echo   3. Select this folder (it is open in Explorer):
echo        %TARGET_DIR%
echo   4. In the AgentShield dashboard, sign in (or create an account),
echo      open My activation and click "Generate activation code".
echo   5. Click the AgentShield icon in the toolbar, paste the code in
echo      the "Activation code" box and click "Connect and verify".
echo      AI sites stay blocked until this is done.
echo      Never share your code: it connects a browser to your account.
echo ========================================================
echo.
pause
