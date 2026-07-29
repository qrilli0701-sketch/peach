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

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID")
GOOGLE_CREDENTIALS_FILE = os.getenv("GOOGLE_CREDENTIALS_FILE")

gemini_client = genai.Client(api_key=GEMINI_API_KEY, http_options={"api_version": "v1beta"})

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
creds = Credentials.from_service_account_file(GOOGLE_CREDENTIALS_FILE, scopes=SCOPES)
gc = gspread.authorize(creds)
sheet = gc.open_by_key(SPREADSHEET_ID).sheet1

HEADERS = ["날짜", "받는사람", "받는분전화번호", "수량", "주소", "보내는사람", "보내는분전화번호", "비고", ""]
REQUIRED_FIELDS = ["받는사람", "받는분전화번호", "수량", "주소", "보내는사람"]

def init_sheet():
    first_row = sheet.row_values(1)
    if first_row != [h for h in HEADERS if h != ""]:
        existing = sheet.get_all_values()
        sheet.clear()
        sheet.append_row(HEADERS)
        if len(existing) > 1:
            sheet.append_rows(existing[1:])

init_sheet()

pending_orders = {}
chat_pending_key = {}
pending_api = {}  # message_id -> {"type": ..., "text": ..., "image_bytes": ...}

# ── 키워드 기반 명령 감지 (API 호출 없음) ──────────────────────

def detect_keyword_command(text):
    t = text.strip()

    # 건수 조회
    if re.search(r"(몇\s*건|몇\s*개|얼마나|몇\s*명|총\s*몇)", t):
        return {"type": "get_count"}

    # 최근 조회
    m = re.search(r"최근\s*(\d+)?|마지막\s*(\d+)?건?\s*(보여|알려|조회)", t)
    if m:
        n = int(m.group(1) or m.group(2) or 5)
        return {"type": "get_recent", "n": n}

    # 마지막 N건 삭제
    m = re.search(r"(마지막|방금|지금)\s*(\d+)?\s*건?\s*(지워|삭제|취소)", t)
    if m:
        n = int(m.group(2)) if m.group(2) else 1
        return {"type": "delete_last", "n": n}

    # 이름으로 삭제
    m = re.search(r"(.+?)\s*(거|것|꺼)?\s*(지워줘|삭제해줘|빼줘)", t)
    if m and len(m.group(1)) <= 5:
        return {"type": "delete_by_name", "name": m.group(1).strip()}

    # 전체 삭제
    if re.search(r"(전체|다\s*지워|모두\s*지워|초기화)", t):
        return {"type": "clear_all"}

    # 인사
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

def tool_save_orders(orders):
    today = datetime.now().strftime("%Y-%m-%d")
    rows = [[
        today,
        o.get("받는사람", ""), o.get("받는분전화번호", ""),
        o.get("수량", ""), o.get("주소", ""),
        o.get("보내는사람", ""), o.get("보내는분전화번호", ""),
        o.get("비고", ""), ""
    ] for o in orders]
    sheet.append_rows(rows)

# ── Gemini 호출 (주문 파싱 + 일반 대화) ────────────────────────

ORDER_PARSE_PROMPT = """
아래 주문 내용에서 항목을 JSON 배열로 추출해줘.
없거나 불확실하면 null. 전화번호 축약(010...1234)이면 null.
받는사람(고객)과 보내는사람(발송인) 절대 혼동 금지.
JSON만 반환, 설명 없이.

항목: 받는사람, 받는분전화번호, 수량, 주소, 보내는사람, 보내는분전화번호, 비고

주문 내용:
"""

CORRECTION_PROMPT = """
주문 수정 내용이야. 바꿀 필드만 JSON으로 반환해줘.
필드명: 받는사람, 받는분전화번호, 수량, 주소, 보내는사람, 보내는분전화번호, 비고
"전체/다" 표현 있으면 apply_to_all: true 포함.
JSON만 반환.

수정 내용:
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
    response = gemini_client.models.generate_content(
        model="gemini-2.5-flash-lite",
        contents=CORRECTION_PROMPT + text
    )
    correction = parse_json(response.text)
    apply_to_all = correction.pop("apply_to_all", True)
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

async def show_order_confirm(message, key, orders):
    text = f"✅ 총 {len(orders)}건 인식했어요!\n\n"
    for i, o in enumerate(orders, 1):
        text += format_order(o, i) + "\n\n"
    text += "⚠️ 없음 항목 확인 후 기록하시겠어요?" if has_missing(orders) else "스프레드시트에 기록할까요?"
    kb = [[
        InlineKeyboardButton("✅ 기록", callback_data=f"confirm:{key}"),
        InlineKeyboardButton("❌ 취소", callback_data=f"cancel:{key}"),
    ]]
    await message.reply_text(text, reply_markup=InlineKeyboardMarkup(kb))

# ── 메인 핸들러 ─────────────────────────────────────────────────

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.message
    chat_id = message.chat_id
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

    existing_key = chat_pending_key.get(chat_id)

    # 1. 이미지 → 바로 주문 파싱
    if image_bytes:
        await message.reply_text("📸 이미지 분석 중...")
        try:
            orders = await gemini_parse_order(image_bytes=image_bytes)
            key = str(message.message_id)
            pending_orders[key] = orders
            chat_pending_key[chat_id] = key
            await show_order_confirm(message, key, orders)
        except Exception as e:
            logger.error(f"이미지 파싱 오류: {e}")
            e_str = str(e)
            if "429" in e_str:
                msg = "⚠️ API 한도 초과, 잠시 후 다시 시도해주세요."
            elif "503" in e_str or "UNAVAILABLE" in e_str:
                msg = "⚠️ Gemini 서버가 잠시 혼잡해요. 다시 보내주세요."
            else:
                msg = "⚠️ 이미지 분석 실패. 다시 보내주세요."
            await message.reply_text(msg)
        return

    # 2. 대기 주문 있을 때 → 바로 수정
    if existing_key and existing_key in pending_orders:
        await message.reply_text("✏️ 수정 내용 반영 중...")
        try:
            orders = await gemini_parse_correction(text, pending_orders[existing_key])
            pending_orders[existing_key] = orders
            await show_order_confirm(message, existing_key, orders)
        except Exception as e:
            logger.error(f"수정 파싱 오류: {e}")
            await message.reply_text("⚠️ 수정 내용을 이해하지 못했어요.")
        return

    # 3. 키워드 명령 감지 (API 호출 없음)
    cmd = detect_keyword_command(text)
    if cmd:
        ctype = cmd["type"]

        if ctype == "greeting":
            await message.reply_text("안녕하세요! 😊 주문을 보내주시거나 궁금한 거 물어보세요.")
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

    # 4. 주문처럼 보이면 → 바로 파싱
    order_keywords = ["받는사람", "보내는사람", "주소", "박스", "개입", "수량", "전화번호", "010"]
    if any(kw in text for kw in order_keywords) or len(text) > 30:
        await message.reply_text("📝 주문 내용 분석 중...")
        try:
            orders = await gemini_parse_order(text=text)
            key = str(message.message_id)
            pending_orders[key] = orders
            chat_pending_key[chat_id] = key
            await show_order_confirm(message, key, orders)
        except Exception as e:
            logger.error(f"주문 파싱 오류: {e}")
            await message.reply_text("⚠️ 주문 인식 실패." + (" API 한도 초과, 잠시 후 다시 시도해주세요." if "429" in str(e) else " 다시 보내주세요."))
        return

    # 5. 일반 대화 → 바로 응답
    try:
        reply = await gemini_chat(text)
        await message.reply_text(reply)
    except Exception as e:
        logger.error(f"대화 오류: {e}")
        await message.reply_text("⚠️ 오류 발생." + (" API 한도 초과, 잠시 후 다시 시도해주세요." if "429" in str(e) else ""))



async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    chat_id = query.message.chat_id

    if data.startswith("confirm:"):
        key = data.split(":", 1)[1]
        orders = pending_orders.pop(key, None)
        if not orders:
            await query.edit_message_text("⚠️ 주문 정보를 찾을 수 없어요.")
            return
        tool_save_orders(orders)
        chat_pending_key.pop(chat_id, None)
        await query.edit_message_text(f"✅ {len(orders)}건이 기록됐어요!")

    elif data.startswith("cancel:"):
        key = data.split(":", 1)[1]
        pending_orders.pop(key, None)
        chat_pending_key.pop(chat_id, None)
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

    elif data.startswith("api:"):
        api_key = data.split(":", 1)[1]
        req = pending_api.pop(api_key, None)
        if not req:
            await query.edit_message_text("⚠️ 요청 정보를 찾을 수 없어요.")
            return

        rtype = req["type"]
        req_chat_id = req["chat_id"]

        try:
            if rtype == "order_image":
                await query.edit_message_text("📸 이미지 분석 중...")
                orders = await gemini_parse_order(image_bytes=req["image_bytes"])
                key = api_key
                pending_orders[key] = orders
                chat_pending_key[req_chat_id] = key
                await query.message.reply_text("")  # 자리 확보
                await show_order_confirm(query.message, key, orders)

            elif rtype == "order_text":
                await query.edit_message_text("📝 주문 분석 중...")
                orders = await gemini_parse_order(text=req["text"])
                key = api_key
                pending_orders[key] = orders
                chat_pending_key[req_chat_id] = key
                await show_order_confirm(query.message, key, orders)

            elif rtype == "correction":
                await query.edit_message_text("✏️ 수정 반영 중...")
                order_key = req["order_key"]
                if order_key not in pending_orders:
                    await query.edit_message_text("⚠️ 수정할 주문이 없어요.")
                    return
                orders = await gemini_parse_correction(req["text"], pending_orders[order_key])
                pending_orders[order_key] = orders
                await show_order_confirm(query.message, order_key, orders)

            elif rtype == "chat":
                await query.edit_message_text("💬 답변 생성 중...")
                reply = await gemini_chat(req["text"])
                await query.edit_message_text(reply)

        except Exception as e:
            logger.error(f"API 실행 오류: {e}")
            err = "⚠️ API 호출 한도를 초과했어요. 잠시 후 다시 시도해주세요." if "429" in str(e) else "⚠️ 오류가 발생했어요."
            await query.edit_message_text(err)

    elif data == "api_cancel":
        await query.edit_message_text("❌ 취소됐어요.")


def main():
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(MessageHandler(filters.TEXT | filters.PHOTO, handle_message))
    app.add_handler(CallbackQueryHandler(handle_callback))
    logger.info("봇 시작!")
    app.run_polling()

if __name__ == "__main__":
    main()
