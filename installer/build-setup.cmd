@echo off
rem ===========================================================================
rem  build-setup.cmd - one-click build the Chinese installer AEMCP-Setup.exe
rem
rem  Requirements:
rem    1. pwsh (PowerShell 7)   -- for prepare.ps1 / aemcp-pack.ps1
rem    2. Inno Setup (6 or 7)   -- ISCC.exe compiler
rem
rem  Steps: prepare (BOM + version gate + payload), then ISCC -> AEMCP-Setup.exe
rem ===========================================================================
setlocal
cd /d "%~dp0"

echo [1/2] Preparing payload (BOM + version gate + copy extension files) ...
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepare.ps1"
if errorlevel 1 (
    echo.
    echo FAILED to prepare. See the log above.
    echo.
    pause
    exit /b 1
)

echo [2/2] Packaging into AEMCP-Setup.exe ...
set "ISCC="
if exist "%ProgramFiles%\Inno Setup 7\ISCC.exe"     set "ISCC=%ProgramFiles%\Inno Setup 7\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 7\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 7\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe"     set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC (
    echo.
    echo Inno Setup not found.
    echo Install it from https://jrsoftware.org/isinfo.php then retry.
    echo.
    pause
    exit /b 1
)

"%ISCC%" "%~dp0installer.iss"
if errorlevel 1 (
    echo.
    echo Packaging FAILED. See the Inno Setup log above.
    echo.
    pause
    exit /b 1
)

echo.
echo Done! Installer: %~dp0AEMCP-Setup.exe
echo.
pause
