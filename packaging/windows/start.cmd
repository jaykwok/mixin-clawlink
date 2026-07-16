@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\bun.exe" "%~dp0src\index.ts"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Mixin ClawLink exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
