@echo off
chcp 65001 >nul 2>&1
title KINTENSHAUTO - Build Installer
setlocal EnableDelayedExpansion

echo.
echo  ============================================================
echo   KINTENSHAUTO - Build Installer
echo  ============================================================
echo.
echo   This script will:
echo   1. Check prerequisites
echo   2. Install dependencies (5-30 min)
echo   3. Build Windows installer (.exe)
echo.
echo   Press any key to start, or Ctrl+C to cancel...
pause >nul
echo.

set LOG_FILE=build-log.txt
echo [%date% %time%] Build started > "%LOG_FILE%"

REM ============================================================
REM  Check Node.js
REM ============================================================
echo [1/5] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   ERROR: Node.js not found
    echo.
    echo   Please install Node.js version 18 or higher:
    echo   https://nodejs.org/
    echo.
    echo   After installing, restart this command window and try again.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo       OK: Node.js !NODE_VER!

REM Check Node version (must be >= 18)
for /f "tokens=1 delims=v." %%a in ("!NODE_VER!") do set NODE_MAJOR=%%b
if !NODE_MAJOR! LSS 18 (
    echo.
    echo   ERROR: Node.js version too old ^(!NODE_VER!^)
    echo   Please update to version 18 or higher from https://nodejs.org/
    pause
    exit /b 1
)

REM ============================================================
REM  Check npm
REM ============================================================
echo [2/5] Checking npm...
where npm >nul 2>&1
if errorlevel 1 (
    echo   ERROR: npm not found ^(usually comes with Node.js^)
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('npm --version') do set NPM_VER=%%i
echo       OK: npm !NPM_VER!

REM ============================================================
REM  Check for existing node_modules (skip install if present)
REM ============================================================
echo [3/5] Checking project state...
if exist "node_modules\" (
    echo       node_modules exists - skipping install
    echo       ^(delete node_modules folder if you want to reinstall^)
    goto BUILD
)

REM ============================================================
REM  npm install
REM ============================================================
echo [4/5] Installing dependencies ^(5-30 minutes^)...
echo       Please wait... do not close this window
echo.

set SKIP_POSTINSTALL=1
call npm install >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo.
    echo   ERROR: npm install failed
    echo.
    echo   Common causes:
    echo   - Internet connection problem
    echo   - Firewall blocking npm
    echo   - Missing Visual Studio Build Tools ^(for better-sqlite3^)
    echo.
    echo   Check log file for details: %LOG_FILE%
    echo.
    echo   Solutions:
    echo   1. Retry: close and run build.bat again
    echo   2. Install Visual Studio Build Tools:
    echo      https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo   3. Try: npm install --force
    echo.
    pause
    exit /b 1
)
echo       OK: Dependencies installed

REM ============================================================
REM  Download FFmpeg, yt-dlp
REM ============================================================
echo       Downloading FFmpeg, yt-dlp, fpcalc...
call node scripts\download-deps.js >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo.
    echo   WARNING: Failed to download dependencies
    echo   The installer will download them on first run instead.
    echo.
)

:BUILD
REM ============================================================
REM  Build installer
REM ============================================================
echo [5/5] Building installer ^(5-15 minutes^)...
echo       Please wait...
echo.

call npm run dist:win >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo.
    echo   ERROR: Build failed
    echo   Check log: %LOG_FILE%
    echo.
    pause
    exit /b 1
)

REM ============================================================
REM  Success
REM ============================================================
echo.
echo  ============================================================
echo   BUILD SUCCESSFUL!
echo  ============================================================
echo.

if exist "dist-installer\" (
    echo   Installer file:
    for %%f in (dist-installer\*.exe) do (
        echo   -^> %%f
        for /f %%s in ('powershell -c "[math]::Round((Get-Item '%%f').Length/1MB, 2)"') do (
            echo      Size: %%s MB
        )
    )
    echo.
    echo   Double-click the .exe file to test install
    echo   Or share with others!
    echo.
    echo   Opening dist-installer folder...
    start "" "dist-installer\"
) else (
    echo   Unexpected: dist-installer folder not found
    echo   Check log: %LOG_FILE%
)

echo.
pause
endlocal
