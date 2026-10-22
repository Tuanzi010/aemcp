@echo off
rem ===========================================================================
rem  AE MCP Bridge (com.yg.aemcp) - one-click installer launcher
rem  Keep this file ASCII-only: cmd.exe decodes .cmd with the OEM code page,
rem  Chinese text here turns into mojibake on non-Chinese Windows.
rem  The actual (Chinese) messages come from install.ps1.
rem ===========================================================================
chcp 65001 >nul 2>nul
title AE MCP Bridge - Install
setlocal

set "PS=pwsh"
where pwsh >nul 2>nul
if errorlevel 1 set "PS=powershell"

echo.
echo   AE MCP Bridge  --  installing with %PS%
echo.

%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" echo   [X] installer exited with code %RC%
echo   Press any key to close this window.
pause >nul
endlocal
exit /b %RC%
