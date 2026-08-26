@echo off
chcp 65001 >nul
REM 복숭아 주문 화면 실행. 이 파일을 더블클릭하면 브라우저가 열린다.
cd /d "%~dp0"

REM 프로젝트에 .venv 가 있으면 그걸 쓰고, 없으면 시스템 파이썬을 쓴다.
set PY=.venv\Scripts\python.exe
if not exist "%PY%" set PY=python

"%PY%" ui\server.py %*
if errorlevel 1 (
  echo.
  echo 실행에 실패했습니다.
  echo   - 자격증명 없이 화면만 보려면:  run_ui.bat --demo
  echo   - 필요한 패키지 설치:           %PY% -m pip install -r requirements.txt
  echo.
  pause
)
