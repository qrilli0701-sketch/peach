"""복숭아봇 환경 진단 — 읽기 전용.

시트에 쓰지 않고, 텔레그램 메시지도 보내지 않고, Gemini 생성 호출도 하지 않는다.
(Gemini 무료 할당량 하루 20회를 소모하지 않기 위해 models.list만 사용)
"""
import asyncio
import os
import sys

from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8")  # 윈도우 cp949 콘솔에서 한글 깨짐 방지

load_dotenv()

OK, FAIL, WARN = "[ OK ]", "[FAIL]", "[WARN]"
results = []


def report(status, name, detail=""):
    results.append(status)
    print(f"{status} {name}" + (f"\n       {detail}" if detail else ""))


# 1) 환경변수
print("\n=== 1. 환경변수 ===")
env = {k: os.getenv(k) for k in
       ("TELEGRAM_BOT_TOKEN", "GEMINI_API_KEY", "SPREADSHEET_ID", "GOOGLE_CREDENTIALS_FILE")}
for k, v in env.items():
    report(OK if v else FAIL, k, "" if v else "값이 비어있음")

# 2) 서비스 계정 키 파일
print("\n=== 2. 구글 서비스 계정 ===")
creds = None
cred_path = env["GOOGLE_CREDENTIALS_FILE"]
if cred_path and os.path.exists(cred_path):
    report(OK, "키 파일 존재", cred_path)
    try:
        from google.oauth2.service_account import Credentials
        creds = Credentials.from_service_account_file(
            cred_path, scopes=["https://www.googleapis.com/auth/spreadsheets"])
        report(OK, "키 파싱", f"계정: {creds.service_account_email}")
    except Exception as e:
        report(FAIL, "키 파싱", f"{type(e).__name__}: {e}")
else:
    report(FAIL, "키 파일 존재", f"찾을 수 없음: {cred_path}")

# 3) 스프레드시트 (읽기만)
print("\n=== 3. 스프레드시트 접근 (읽기 전용) ===")
if creds:
    try:
        import gspread
        sheet = gspread.authorize(creds).open_by_key(env["SPREADSHEET_ID"]).sheet1
        report(OK, "시트 열기", f"제목: {sheet.spreadsheet.title} / 탭: {sheet.title}")

        HEADERS = ["입력시각", "받는사람", "받는분전화번호", "수량", "주소",
                   "보내는사람", "보내는분전화번호", "비고", "입력자"]
        actual = sheet.row_values(1)
        if actual == HEADERS:
            report(OK, "헤더 일치", "init_sheet()가 시트를 재작성하지 않음")
        else:
            report(WARN, "헤더 불일치",
                   f"현재: {actual}\n       →  bot_v2.py 실행 시 시트를 clear() 후 재작성함 (데이터는 보존)")

        rows = sheet.get_all_values()
        report(OK, "데이터 읽기", f"기록된 주문 {max(len(rows) - 1, 0)}건")
    except Exception as e:
        report(FAIL, "시트 접근", f"{type(e).__name__}: {e}\n"
               "       → 서비스 계정이 시트에 공유돼 있는지, 시트가 살아있는지 확인 필요")
else:
    report(FAIL, "시트 접근", "인증 정보가 없어 건너뜀")

# 4) 텔레그램 (getMe — 메시지 전송 없음)
print("\n=== 4. 텔레그램 봇 ===")


async def check_telegram():
    from telegram import Bot
    bot = Bot(token=env["TELEGRAM_BOT_TOKEN"])
    async with bot:
        return await bot.get_me()


if env["TELEGRAM_BOT_TOKEN"]:
    try:
        me = asyncio.run(check_telegram())
        report(OK, "토큰 유효", f"@{me.username} ({me.first_name})")
        report(OK if not me.can_read_all_group_messages else OK, "그룹 메시지 수신",
               "가능 (Privacy OFF)" if me.can_read_all_group_messages
               else "불가 — BotFather에서 Group Privacy를 OFF로 바꿔야 그룹에서 동작함")
    except Exception as e:
        report(FAIL, "토큰 유효", f"{type(e).__name__}: {e}")
else:
    report(FAIL, "토큰 유효", "토큰 없음")

# 5) Gemini (모델 목록만 — 생성 호출 안 함)
print("\n=== 5. Gemini ===")
if env["GEMINI_API_KEY"]:
    try:
        from google import genai
        client = genai.Client(api_key=env["GEMINI_API_KEY"],
                              http_options={"api_version": "v1beta"})
        names = [m.name for m in client.models.list()]
        report(OK, "API 키 유효", f"사용 가능 모델 {len(names)}개")
        target = "gemini-2.5-flash-lite"
        if any(target in n for n in names):
            report(OK, "모델 사용 가능", target)
        else:
            flash = [n for n in names if "flash" in n][:5]
            report(FAIL, "모델 사용 가능",
                   f"{target} 없음 — bot_v2.py의 모델명 교체 필요\n"
                   f"       대안 후보: {flash}")
    except Exception as e:
        report(FAIL, "API 키 유효", f"{type(e).__name__}: {e}")
else:
    report(FAIL, "API 키 유효", "키 없음")

print("\n" + "=" * 50)
print(f"통과 {results.count(OK)} / 경고 {results.count(WARN)} / 실패 {results.count(FAIL)}")
print("=" * 50)
