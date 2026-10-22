@echo off
rem ===========================================================================
rem  AE MCP Bridge (com.yg.aemcp) - uninstaller launcher
rem  ASCII-only on purpose (see 安装.cmd for the reason).
rem ===========================================================================
chcp 65001 >nul 2>nul
title AE MCP Bridge - Uninstall
setlocal

set "PS=pwsh"
where pwsh >nul 2>nul
if errorlevel 1 set "PS=powershell"

echo.
echo   AE MCP Bridge  --  uninstalling with %PS%
echo   (make sure After Effects is fully closed)
echo.

%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" echo   [X] uninstaller exited with code %RC%
echo   Press any key to close this window.
pause >nul
endlocal
exit /b %RC%
