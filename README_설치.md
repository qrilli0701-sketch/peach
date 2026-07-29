# 복숭아 주문 작업 — 새 컴퓨터 설치 안내

이 zip은 "주문 이미지 → 정리 → 구글 시트 기록" 작업 환경 전체다.
아래 3단계면 다른 컴퓨터에서 그대로 쓸 수 있다.

## 0. 미리 필요한 것
- Claude Code (앱 또는 CLI)
- Python 3.13 (또는 3.10+). 설치 시 "Add to PATH" 체크 권장

## 1. 압축 풀기
이 zip을 원하는 위치에 푼다. 예: `바탕화면\ClaudeProject`
푼 뒤 폴더 구조가 이래야 한다:
```
ClaudeProject\
  .claude\        (스킬·에이전트 — 지우지 말 것)
  peach-bot\      (코드·설정)
  README_설치.md  (이 파일)
```
**Claude Code는 반드시 `ClaudeProject` 폴더를 열어서 작업한다.** (peach-bot 이 아니라 그 상위 폴더)

## 2. 파이썬 환경 만들기 (한 번만)
`peach-bot` 폴더에서 명령창(PowerShell)을 열고:
```
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```
설치되는 것: gspread, google-auth, python-dotenv 등 (몇 분 걸림)

## 3. 동작 확인
```
.venv\Scripts\python.exe peach.py count
```
`📊 전체 N건 ...` 이 나오면 성공. 기존 컴퓨터와 같은 시트를 본다.

에러가 나면 대개 아래 둘 중 하나다:
- `.env` 또는 구글 키 파일(`gen-lang-client-*.json`)이 안 풀렸다 → zip에 들어있으니 확인
- 파이썬을 못 찾는다 → `python` 대신 `py -3.13` 로 시도

## 리눅스 / macOS 또는 Claude Code 원격 세션에서

경로 구분자와 venv 위치만 다르다. `peach-bot` 폴더에서:
```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python peach.py count
```
`.venv/Scripts/python.exe` 대신 `.venv/bin/python` 을 쓰면 나머지는 동일하다.

원격 세션(Claude Code on the web 등)은 컨테이너가 일정 시간 뒤 사라진다.
`.env` 와 구글 키 파일은 git 에 올라가지 않으므로(=올리면 안 되므로) 세션이 새로
시작될 때마다 다시 올려야 한다. `backups/` 도 마찬가지로 남지 않으니, 백업을
보관하려면 세션 안에서 받아둘 것.

## 이후 사용법
Claude Code에서 `ClaudeProject` 폴더를 열고, 주문 이미지를 주면서
"정리해서 기록해줘" 또는 `/peach` 라고 하면 된다. 나머지는 Claude가 안내한다.

## ⚠️ 보안 주의
이 zip 안에는 **구글 서비스 계정 개인키와 시트 접근 정보**가 들어있다.
- 남에게 보내거나 공개 클라우드/채팅에 올리지 말 것
- USB나 본인 개인 클라우드로만 옮기고, 옮긴 뒤엔 원본 zip을 지우는 게 안전하다
- 시트 데이터(고객 이름·전화·주소)는 개인정보다

## 참고
- 자세한 구조·규칙은 `peach-bot\작업요약_v2.md`
- 삭제는 기본이 미리보기다. 실제 삭제/복원은 `--commit` 을 붙여야 하고 자동 백업된다
