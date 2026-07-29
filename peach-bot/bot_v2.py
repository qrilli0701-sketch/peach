import os
import json
import re
import logging
from datetime import datetime
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, MessageHandler, CallbackQueryHandler, filters, ContextTypes
from google import genai
from google.genai import types
import gspread
from google.oauth2.service_account import Credentials

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# httpx는 INFO 레벨에서 요청 URL을 그대로 남기는데, 텔레그램 API는 봇 토큰을
# URL 경로에 넣는다(/bot<TOKEN>/getMe). 그대로 두면 로그 파일에 토큰이 평문으로
# 쌓이므로 WARNING 이상만 남긴다.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def with_retry(fn, attempts=4, base=1.5):
    """Sheets API의 일시적 오류(429/5xx)에 대해 지수 백오프로 재시도."""
    import time

    import gspread.exceptions
    for i in range(attempts):
        try:
            return fn()
        except gspread.exceptions.APIError as e:
            code = e.response.status_code if e.response is not None else 0
            if code not in (429, 500, 502, 503, 504) or i == attempts - 1:
                raise
            wait = base * (2 ** i)
            logger.warning(f"Sheets {code} — {wait:.1f}초 후 재시도 ({i + 1}/{attempts - 1})")
            time.sleep(wait)

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")
GOOGLE_CREDENTIALS_FILE = os.getenv("GOOGLE_CREDENTIALS_FILE")

gemini_client = genai.Client(api_key=GEMINI_API_KEY, http_options={"api_version": "v1beta"})

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
creds = Credentials.from_service_account_file(GOOGLE_CREDENTIALS_FILE, scopes=SCOPES)
gc = gspread.authorize(creds)
sheet = gc.open_by_key(SPREADSHEET_ID).sheet1

HEADERS = ["입력시각", "받는사람", "받는분전화번호", "수량", "주소", "보내는사람", "보내는분전화번호", "비고", "입력자"]
REQUIRED_FIELDS = ["받는사람", "받는분전화번호", "수량", "주소", "보내는사람"]

def clear_validation():
    try:
        sheet.spreadsheet.batch_update({
            "requests": [{
                "setDataValidation": {
                    "range": {"sheetId": sheet.id},
                    "rule": None
                }
            }]
        })
    except Exception as e:
        logger.warning(f"유효성 검사 제거 실패(무시): {e}")

def init_sheet():
    first_row = sheet.row_values(1)
    if first_row != [h for h in HEADERS if h != ""]:
        existing = sheet.get_all_values()
        sheet.clear()
        sheet.append_row(HEADERS)
        if len(existing) > 1:
            sheet.append_rows(existing[1:])
    clear_validation()

init_sheet()

# (chat_id, user_id) → pending key (그룹에서 각자의 대기 주문 구분)
pending_orders = {}
user_pending_key = {}

# ── 키워드 기반 명령 감지 ───────────────────────────────────────

def detect_keyword_command(text):
    t = text.strip()

    if re.search(r"(몇\s*건|몇\s*개|얼마나|몇\s*명|총\s*몇)", t):
        return {"type": "get_count"}

    m = re.search(r"최근\s*(\d+)?|마지막\s*(\d+)?건?\s*(보여|알려|조회)", t)
    if m:
        n = int(m.group(1) or m.group(2) or 5)
        return {"type": "get_recent", "n": n}

    m = re.search(r"(마지막|방금|지금)\s*(\d+)?\s*건?\s*(지워|삭제|취소)", t)
    if m:
        n = int(m.group(2)) if m.group(2) else 1
        return {"type": "delete_last", "n": n}

    # 전체 삭제를 이름 삭제보다 먼저 검사한다.
    # "전체 지워줘"의 "전체"(2글자)가 아래 이름 삭제 조건(5글자 이하)에 걸려
    # delete_by_name("전체")로 잡히던 문제 때문.
    if re.search(r"(전체|다\s*지워|모두\s*지워|초기화)", t):
        return {"type": "clear_all"}

    m = re.search(r"(.+?)\s*(거|것|꺼)?\s*(지워줘|삭제해줘|빼줘)", t)
    if m and len(m.group(1)) <= 5:
        return {"type": "delete_by_name", "name": m.group(1).strip()}

    if re.search(r"^(안녕|ㅎㅇ|하이|헬로|hello|hi)[\s!~]*$", t, re.IGNORECASE):
        return {"type": "greeting"}

    return None

# ── 스프레드시트 도구 ───────────────────────────────────────────

def tool_get_count():
    today = datetime.now().strftime("%Y-%m-%d")
    rows = sheet.get_all_values()
    data = rows[1:] if len(rows) > 1 else []
    total = len(data)
    today_count = sum(1 for r in data if r and r[0] == today)
    return f"📊 전체 {total}건 기록됨 (오늘 {today_count}건)"

def tool_get_recent(n=5):
    rows = sheet.get_all_values()
    data = rows[1:] if len(rows) > 1 else []
    recent = data[-n:] if len(data) >= n else data
    if not recent:
        return "📋 기록된 주문이 없어요."
    lines = [f"📋 최근 {len(recent)}건:"]
    for r in recent:
        addr = r[4][:15] + "..." if len(r[4]) > 15 else r[4]
        lines.append(f"• {r[0]} | {r[1]} | {r[3]} | {addr}")
    return "\n".join(lines)

def tool_delete_last(n=1):
    rows = sheet.get_all_values()
    data_count = len(rows) - 1
    if data_count <= 0:
        return False, "삭제할 데이터가 없어요."
    n = min(n, data_count)
    for i in range(len(rows), len(rows) - n, -1):
        sheet.delete_rows(i)
    return True, f"마지막 {n}건을 삭제했어요."

def tool_delete_by_name(name):
    rows = sheet.get_all_values()
    deleted = 0
    for i in range(len(rows), 1, -1):
        if rows[i-1][1] == name:
            sheet.delete_rows(i)
            deleted += 1
    if deleted:
        return True, f"'{name}' 항목 {deleted}건을 삭제했어요."
    return False, f"'{name}' 이름의 항목을 찾지 못했어요."

def tool_clear_all():
    sheet.clear()
    sheet.append_row(HEADERS)
    return True, "모든 데이터를 삭제했어요."

def tool_save_orders(orders, sender_name=""):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    # Gemini가 값을 못 찾으면 null을 주는데, .get(k, "")는 키가 있으면 None을 그대로
    # 돌려준다. None이 섞인 행은 append_rows에서 거부되므로 `or ""`로 정규화한다.
    def v(o, k):
        return o.get(k) or ""

    rows = [[
        now,
        v(o, "받는사람"), v(o, "받는분전화번호"),
        v(o, "수량"), v(o, "주소"),
        v(o, "보내는사람"), v(o, "보내는분전화번호"),
        v(o, "비고"), sender_name
    ] for o in orders]
    with_retry(lambda: sheet.append_rows(rows, value_input_option="RAW"))

# ── Gemini 호출 ─────────────────────────────────────────────────

ORDER_PARSE_PROMPT = """
아래 주문 내용에서 항목을 JSON 배열로 추출해줘.
없거나 불확실하면 null. 전화번호 축약(010...1234)이면 null.
받는사람(고객)과 보내는사람(발송인) 절대 혼동 금지.
JSON만 반환, 설명 없이.

항목: 받는사람, 받는분전화번호, 수량, 주소, 보내는사람, 보내는분전화번호, 비고

주문 내용:
"""

CORRECTION_PROMPT = """
아래는 현재 주문 내용과 사용자의 수정 요청이야.
수정 요청을 반영해서 바뀌는 필드만 JSON으로 반환해줘. 값은 반드시 실제 데이터(문자열/숫자)여야 하고,
필드명을 값으로 넣거나 "같아", "동일" 같은 표현을 그대로 넣으면 안 돼.

예: 현재 받는사람이 "신인경"이고 사용자가 "보내는사람도 받는사람이랑 같아"라고 하면
반환값은 {"보내는사람": "신인경"} 이어야 해. {"보내는사람": "받는사람"}처럼 필드명을 값으로 쓰면 안 돼.

필드명: 받는사람, 받는분전화번호, 수량, 주소, 보내는사람, 보내는분전화번호, 비고
JSON만 반환, 설명 없이.

현재 주문 내용:
{orders}

수정 요청:
{request}
"""

CHAT_SYSTEM = """너는 복숭아 농산물 사업을 돕는 친근한 AI야. 짧고 자연스럽게 대화해줘. 한국어로."""

def parse_json(text):
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())

async def gemini_parse_order(text=None, image_bytes=None):
    if image_bytes:
        image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")
        response = gemini_client.models.generate_content(
            model="gemini-2.5-flash-lite",
            contents=[ORDER_PARSE_PROMPT, image_part]
        )
    else:
        response = gemini_client.models.generate_content(
            model="gemini-2.5-flash-lite",
            contents=ORDER_PARSE_PROMPT + text
        )
    orders = parse_json(response.text)
    if isinstance(orders, dict):
        orders = [orders]
    return orders

async def gemini_parse_correction(text, orders):
    orders_json = json.dumps(orders, ensure_ascii=False, indent=2)
    prompt = CORRECTION_PROMPT.replace("{orders}", orders_json).replace("{request}", text)
    response = gemini_client.models.generate_content(
        model="gemini-2.5-flash-lite",
        contents=prompt
    )
    correction = parse_json(response.text)
    correction.pop("apply_to_all", None)
    for o in orders:
        o.update(correction)
    return orders

async def gemini_chat(text):
    response = gemini_client.models.generate_content(
        model="gemini-2.5-flash-lite",
        contents=[CHAT_SYSTEM, text]
    )
    return response.text.strip()

# ── 주문 표시 ───────────────────────────────────────────────────

def format_order(order, index=None):
    prefix = f"📦 주문 {index}건" if index else "📦 주문"
    def val(k):
        v = order.get(k)
        return v if v else "⚠️ 없음"
    return (
        f"{prefix}\n"
        f"받는사람: {val('받는사람')}\n"
        f"전화번호: {val('받는분전화번호')}\n"
        f"수량: {val('수량')}\n"
        f"주소: {val('주소')}\n"
        f"보내는사람: {val('보내는사람')}\n"
        f"보내는분 전화번호: {val('보내는분전화번호')}\n"
        f"비고: {order.get('비고') or '-'}"
    )

def has_missing(orders):
    return any(not o.get(f) for o in orders for f in REQUIRED_FIELDS)

ORDER_KEYWORDS = ["받는사람", "보내는사람", "주소", "박스", "개입", "수량", "전화번호", "010"]
CORRECTION_KEYWORDS = ["고쳐", "수정", "바꿔", "바꾸", "변경", "정정"]

def looks_like_new_order(text):
    return any(kw in text for kw in ORDER_KEYWORDS) or len(text) > 30 or text.count("\n") >= 2

def is_correction_request(text):
    return any(kw in text for kw in CORRECTION_KEYWORDS)

def get_sender_name(message):
    user = message.from_user
    if user.full_name:
        return user.full_name
    return user.username or "알 수 없음"

async def show_order_confirm(message, key, orders, sender_name=None):
    header = f"👤 {sender_name} 님의 주문\n" if sender_name else ""
    text = header + f"✅ 총 {len(orders)}건 인식했어요!\n\n"
    for i, o in enumerate(orders, 1):
        text += format_order(o, i) + "\n\n"
    text += "⚠️ 없음 항목 확인 후 기록하시겠어요?" if has_missing(orders) else "스프레드시트에 기록할까요?"
    kb = [[
        InlineKeyboardButton("✅ 기록", callback_data=f"confirm:{key}"),
        InlineKeyboardButton("❌ 취소", callback_data=f"cancel:{key}"),
    ]]
    await message.reply_text(text, reply_markup=InlineKeyboardMarkup(kb))

def gemini_error_msg(e):
    e_str = str(e)
    if "429" in e_str:
        return "⚠️ API 한도 초과, 잠시 후 다시 시도해주세요."
    if "503" in e_str or "UNAVAILABLE" in e_str:
        return "⚠️ Gemini 서버가 잠시 혼잡해요. 다시 시도해주세요."
    return "⚠️ 오류가 발생했어요. 다시 시도해주세요."

# ── 메인 핸들러 ─────────────────────────────────────────────────

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.message
    chat_id = message.chat_id
    user_id = message.from_user.id
    user_key = (chat_id, user_id)  # 그룹에서 각자 구분
    text = message.text or ""
    image_bytes = None

    if message.photo:
        photo = message.photo[-1]
        file = await context.bot.get_file(photo.file_id)
        image_bytes = bytes(await file.download_as_bytearray())

    if not text and not image_bytes:
        return
    if text.startswith("/"):
        return

    sender_name = get_sender_name(message)
    existing_key = user_pending_key.get(user_key)

    # 대기 중인 주문이 있는데 수정 지시가 아닌 새 주문(이미지 or 새 주문 형태 텍스트)이 오면 이전 것 자동 취소
    if existing_key and existing_key in pending_orders:
        if image_bytes or (looks_like_new_order(text) and not is_correction_request(text)):
            pending_orders.pop(existing_key, None)
            user_pending_key.pop(user_key, None)
            await message.reply_text("↩️ 이전 대기 중이던 주문은 자동 취소됐어요.")
            existing_key = None

    # 1. 이미지 → 주문 파싱
    if image_bytes:
        await message.reply_text(f"📸 {sender_name} 님의 이미지 분석 중...")
        try:
            orders = await gemini_parse_order(image_bytes=image_bytes)
            key = f"{chat_id}:{user_id}:{message.message_id}"
            pending_orders[key] = orders
            user_pending_key[user_key] = key
            await show_order_confirm(message, key, orders, sender_name)
        except Exception as e:
            logger.error(f"이미지 파싱 오류: {e}")
            await message.reply_text(gemini_error_msg(e))
        return

    # 2. 대기 주문 있고, 명시적 수정 지시일 때 → 수정
    if existing_key and existing_key in pending_orders and is_correction_request(text):
        await message.reply_text("✏️ 수정 내용 반영 중...")
        try:
            orders = await gemini_parse_correction(text, pending_orders[existing_key])
            pending_orders[existing_key] = orders
            await show_order_confirm(message, existing_key, orders, sender_name)
        except Exception as e:
            logger.error(f"수정 파싱 오류: {e}")
            await message.reply_text(gemini_error_msg(e))
        return

    # 3. 키워드 명령 감지 (API 없음)
    cmd = detect_keyword_command(text)
    if cmd:
        ctype = cmd["type"]

        if ctype == "greeting":
            await message.reply_text(f"안녕하세요 {sender_name} 님! 😊 주문을 보내주시거나 궁금한 거 물어보세요.")
            return

        if ctype == "get_count":
            await message.reply_text(tool_get_count())
            return

        if ctype == "get_recent":
            await message.reply_text(tool_get_recent(cmd.get("n", 5)))
            return

        if ctype in ("delete_last", "delete_by_name", "clear_all"):
            if ctype == "delete_last":
                label = f"마지막 {cmd.get('n', 1)}건 삭제"
            elif ctype == "delete_by_name":
                label = f"'{cmd['name']}' 항목 삭제"
            else:
                label = "전체 데이터 삭제"
            cb_data = json.dumps(cmd, ensure_ascii=False)
            kb = [[
                InlineKeyboardButton("✅ 확인", callback_data=f"cmd:{cb_data}"),
                InlineKeyboardButton("❌ 취소", callback_data="cmd_cancel"),
            ]]
            await message.reply_text(f"⚠️ {label}할까요?", reply_markup=InlineKeyboardMarkup(kb))
            return

    # 4. 주문처럼 보이면 → 파싱
    if looks_like_new_order(text):
        await message.reply_text(f"📝 {sender_name} 님의 주문 분석 중...")
        try:
            orders = await gemini_parse_order(text=text)
            key = f"{chat_id}:{user_id}:{message.message_id}"
            pending_orders[key] = orders
            user_pending_key[user_key] = key
            await show_order_confirm(message, key, orders, sender_name)
        except Exception as e:
            logger.error(f"주문 파싱 오류: {e}")
            await message.reply_text(gemini_error_msg(e))
        return

    # 5. 일반 대화
    try:
        reply = await gemini_chat(text)
        await message.reply_text(reply)
    except Exception as e:
        logger.error(f"대화 오류: {e}")
        await message.reply_text(gemini_error_msg(e))


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    chat_id = query.message.chat_id
    user_id = query.from_user.id
    user_key = (chat_id, user_id)

    if data.startswith("confirm:"):
        key = data.split(":", 1)[1]
        # pop이 아니라 get. 저장이 성공한 뒤에만 제거해야 실패 시 재시도할 수 있다.
        orders = pending_orders.get(key)
        if not orders:
            await query.edit_message_text("⚠️ 주문 정보를 찾을 수 없어요.")
            return
        sender_name = query.from_user.full_name or query.from_user.username or "알 수 없음"
        try:
            tool_save_orders(orders, sender_name)
        except Exception as e:
            logger.error(f"시트 저장 실패: {e}", exc_info=True)
            await query.edit_message_text(
                f"⚠️ 기록에 실패했어요: {type(e).__name__}\n"
                "주문은 그대로 있으니 ✅ 기록을 다시 눌러주세요.",
                reply_markup=query.message.reply_markup,  # 버튼 유지
            )
            return
        pending_orders.pop(key, None)
        user_pending_key.pop(user_key, None)
        await query.edit_message_text(f"✅ {len(orders)}건이 기록됐어요!")

    elif data.startswith("cancel:"):
        key = data.split(":", 1)[1]
        pending_orders.pop(key, None)
        user_pending_key.pop(user_key, None)
        await query.edit_message_text("❌ 취소됐어요.")

    elif data.startswith("cmd:"):
        cmd = json.loads(data[4:])
        ctype = cmd.get("type")
        if ctype == "delete_last":
            ok, msg = tool_delete_last(cmd.get("n", 1))
        elif ctype == "delete_by_name":
            ok, msg = tool_delete_by_name(cmd.get("name", ""))
        elif ctype == "clear_all":
            ok, msg = tool_clear_all()
        else:
            ok, msg = False, "알 수 없는 명령이에요."
        await query.edit_message_text(("✅ " if ok else "⚠️ ") + msg)

    elif data == "cmd_cancel":
        await query.edit_message_text("❌ 취소됐어요.")


def main():
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    # 개인 채팅 + 그룹 채팅 모두 수신
    group_filter = filters.ChatType.GROUPS | filters.ChatType.PRIVATE
    app.add_handler(MessageHandler((filters.TEXT | filters.PHOTO) & group_filter, handle_message))
    app.add_handler(CallbackQueryHandler(handle_callback))
    logger.info("봇 v2 시작! (그룹 지원)")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
