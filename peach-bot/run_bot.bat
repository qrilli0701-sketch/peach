@echo off
REM Peach order bot launcher with auto-restart loop.
REM ASCII + CRLF only: cmd.exe misparses UTF-8/LF batch files on a cp949 system.
REM Task Scheduler RestartOnFailure does NOT cover a process that exits with an
REM error code, so the restart loop lives here instead.
cd /d "%~dp0"
if not exist logs mkdir logs
set PYTHONIOENCODING=utf-8

:loop
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%I
echo.>> "logs\bot_%TODAY%.log"
echo ===== START %DATE% %TIME% =====>> "logs\bot_%TODAY%.log"
".venv\Scripts\python.exe" -u bot_v2.py >> "logs\bot_%TODAY%.log" 2>&1
echo ===== EXIT code %ERRORLEVEL% at %DATE% %TIME% - restarting in 10s =====>> "logs\bot_%TODAY%.log"
REM ping instead of timeout: timeout fails when stdin is not a console
ping -n 11 127.0.0.1 >nul
goto loop
