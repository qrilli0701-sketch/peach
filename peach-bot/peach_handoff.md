# peach 작업 핸드오프

복숭아 주문 관리 작업을 다른 세션에서 이어가기 위한 인수인계 문서.
새 세션에서 이 파일과 아래 핵심 파일들을 읽으면 하던 지점부터 이어갈 수 있다.

## 다음에 할 일 (목표)
지금까지의 **복숭아 주문 처리 워크플로우를 HTML 인터페이스로 구현**한다.
출발 아이디어는 맨 아래 "HTML 인터페이스" 참고.

---

## 시스템 개요
주문(이미지·붙여넣기 텍스트·엑셀·손글씨) → 판독 → 검증 → Google 스프레드시트 기록.

구성원:
- **오케스트레이터(Claude 본체)** — 주문 받아 판독하고 흐름을 지휘, 기록 실행
- **판독팀 서브에이전트** (`.claude/agents/`) — `peach-reader`(추출) → `peach-checker`(원본 대조) → `peach-lead`(행별 기록/보류 판정). *파일 경로가 있는 이미지에만 사용 가능*
- **validate.py** — 기록 직전 검증 레이어
- **peach.py** — Google 시트 입출력 CLI
- **Google Sheet** — 최종 저장소

## 핵심 파일
- `peach.py` — 시트 CLI. 명령: `add`, `add-checked`, `count`, `recent`, `search`(중복확인), `delete-last`, `delete-name`, `clear`, `highlight`(빈칸 노란음영), `backup`, `restore`
- `validate.py` — 검증. 현재 **전화번호 자릿수만** 판정에 사용. `check_road_address`(juso), `check_sido` 함수는 남아있지만 호출 안 함(되살리려면 `validate_order`에서 다시 부르면 됨)
- `.claude/agents/peach-reader.md`, `peach-checker.md`, `peach-lead.md`
- `.env` (git 제외) — `SPREADSHEET_ID`, `GOOGLE_CREDENTIALS_FILE`, `JUSO_CONFM_KEY`
- 시트 열: `입력시각 · 받는사람 · 받는분전화번호 · 수량 · 주소 · 보내는사람 · 보내는분전화번호 · 비고`

## 결정된 규칙 (중요)
1. **기록 전 사용자 확인 받기** — 정리한 표를 먼저 보여주고 "넣어" 하면 기록.
2. **검증은 전화번호 자릿수만** — 010은 반드시 11자리, `010-1234-5678`로 정규화. 주소·시도는 사람이 눈으로 확인. (시/도 화이트리스트 검사는 도 생략 주소를 헛걸러서 제거함)
3. **주소 juso API는 이 원격 세션에서 차단됨**(조직 egress 정책, `EGRESS_BLOCKED`/403). 로컬 PC나 허용 환경에서만 작동. 그래서 `add-checked`의 주소검사는 늘 SKIP.
4. **불확실·빈 칸은 노란음영** 으로 표시 — `peach.py highlight` 또는 직접 `batch_format`(`YELLOW` = {1.0, 0.95, 0.6}).
5. **가격 모델** — 박스당 40,000원 + 택배 5,000원(2박스까지 묶음). 예: 2박스=85,000, 1박스=45,000.
6. **붙여넣기 이미지/텍스트는 파일 경로가 없어** 판독팀 서브에이전트를 못 씀 → 오케스트레이터가 직접 판독. **손글씨 사진이 파일로 저장돼 올 때만** reader→checker→lead 체인 가동.
7. 자동 교정 금지 — 오타로 보여도 원문대로 넣고, 애매하면 확인 요청하거나 노란음영.

## 현재 상태
- 전체 약 515건 기록됨.
- 작업 브랜치: `claude/peach-work-01cq4m`
- 미결: 8/25 주문2(KB 안산종합금융센터) 보내는사람 3건은 손글씨 판독 불가로 **비움+음영** 처리됨 — 사용자가 발송자 확정하면 채우면 됨.

## 실행 메모
- 의존성: `pip install -r requirements.txt` (gspread, google-auth, python-dotenv, requests 등). 이 환경은 시스템 파이썬에 이미 설치돼 있어 `python3 peach.py ...` 로 실행.
- 기록: 주문을 JSON 배열로 만들어 `python3 peach.py add <파일.json>` (같은 날 이어 넣을 땐 `--no-separator`).

---

## HTML 인터페이스 (출발 아이디어)
- **주문 붙여넣기 → 파싱 미리보기 표 → 확인 → 기록** 흐름을 화면으로.
- 전화번호 검증 결과 표시(자릿수 오류 강조), 확인 필요 항목 노란음영 시각화.
- 중복 검색(`search`) 뷰, 최근 기록(`recent`) 뷰, 건수(`count`) 대시보드.
- 주의: 실제 구글시트 쓰기는 서비스계정 키가 필요하므로 백엔드(또는 로컬 실행) 전제. 정적 HTML만으로는 시트에 못 씀 — 파싱·미리보기·검증 UI까지가 프런트, 기록은 `peach.py` 호출/백엔드로 연결.
