"""복숭아 주문 스프레드시트 CLI.

텔레그램/Gemini 없이, 이미 파싱된 주문을 스프레드시트에 기록하고 조회/삭제한다.
이미지 판독은 Claude가 하고, 이 스크립트는 시트 입출력만 담당한다.

사용법:
    python peach.py add '<JSON 배열>'
    python peach.py add -            # stdin 으로 JSON 입력
    python peach.py count
    python peach.py recent [N]
    python peach.py search <검색어>
    python peach.py delete-last [N]
    python peach.py delete-name <이름>
    python peach.py clear --yes
"""
import os
import sys
import json
import time
import argparse
import logging
from datetime import datetime

from dotenv import load_dotenv
import gspread
import gspread.exceptions
from google.oauth2.service_account import Credentials

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# 윈도우 콘솔 기본 코드페이지(cp949)는 이모지를 못 찍는다.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

logging.basicConfig(level=logging.WARNING, format="%(message)s")
logger = logging.getLogger(__name__)

HEADERS = ["입력시각", "받는사람", "받는분전화번호", "수량", "주소",
           "보내는사람", "보내는분전화번호", "비고"]
FIELDS = HEADERS[1:]


def with_retry(fn, attempts=4, base=1.5):
    """Sheets API의 일시적 오류(429/5xx)에 대해 지수 백오프로 재시도."""
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


def get_sheet(spreadsheet_id=None):
    """시트 핸들. spreadsheet_id 를 안 주면 .env 의 SPREADSHEET_ID 를 쓴다(원래 동작).

    웹 UI 는 원래 작업과 다른 시트를 쓰려고 UI_SPREADSHEET_ID 를 넘긴다.
    자격증명(서비스 계정)은 두 시트가 공유한다 — 같은 계정이 둘 다 편집자면 된다.
    """
    base = os.path.dirname(os.path.abspath(__file__))
    cred_file = os.getenv("GOOGLE_CREDENTIALS_FILE")
    if not os.path.isabs(cred_file):
        cred_file = os.path.join(base, cred_file)
    creds = Credentials.from_service_account_file(
        cred_file, scopes=["https://www.googleapis.com/auth/spreadsheets"])
    sid = spreadsheet_id or os.getenv("SPREADSHEET_ID")
    return gspread.authorize(creds).open_by_key(sid).sheet1


def clear_validation(sheet):
    """gspread 저장 시 400을 유발하는 데이터 유효성 검사 규칙을 제거한다."""
    try:
        sheet.spreadsheet.batch_update({
            "requests": [{"setDataValidation": {"range": {"sheetId": sheet.id}, "rule": None}}]
        })
    except Exception as e:
        logger.warning(f"유효성 검사 제거 실패(무시): {e}")


def init_sheet(sheet):
    if sheet.row_values(1) != HEADERS:
        existing = sheet.get_all_values()
        sheet.clear()
        sheet.append_row(HEADERS)
        if len(existing) > 1:
            sheet.append_rows(existing[1:])
    clear_validation(sheet)


def is_blank(row):
    """날짜 구분용으로 넣은 빈 행인지."""
    return not any((c or "").strip() for c in row)


def data_rows(sheet, include_blank=False):
    """헤더를 제외한 행. 기본적으로 날짜 구분용 빈 행은 제외한다."""
    rows = sheet.get_all_values()[1:]
    return rows if include_blank else [r for r in rows if not is_blank(r)]


def last_record_date(sheet):
    """마지막으로 기록된 행의 날짜(YYYY-MM-DD). 데이터가 없으면 None."""
    data = data_rows(sheet)
    return data[-1][0][:10] if data else None


def missing_name_rows(orders):
    """받는사람이 빈 행의 1-기반 번호 목록. 인코딩 깨짐/키 오타를 잡는 마지막 방어선."""
    return [i for i, o in enumerate(orders, 1) if not (o.get("받는사람") or "").strip()]


def append_orders(sheet, orders, no_separator=False):
    """주문 배열을 시트에 덧붙인다. 날짜가 바뀌었으면 구분용 빈 행을 한 줄 넣는다.

    CLI 와 UI 서버가 같은 경로로 기록하도록 여기 한 곳에 모아둔다.
    반환: {"rows": 기록한 데이터 행, "separator": bool, "prev_date": str|None, "date": str}
    """
    now = datetime.now()
    rows = [[now.strftime("%Y-%m-%d %H:%M:%S")] + [(o.get(k) or "") for k in FIELDS]
            for o in orders]
    prev = last_record_date(sheet)
    today = now.strftime("%Y-%m-%d")
    separator = prev is not None and prev != today and not no_separator
    payload = ([[""] * len(HEADERS)] + rows) if separator else rows
    with_retry(lambda: sheet.append_rows(payload, value_input_option="RAW"))
    return {"rows": rows, "separator": separator, "prev_date": prev, "date": today}


# ── 명령 ────────────────────────────────────────────────────────

def cmd_add(sheet, args):
    # 윈도우에서 stdin 기본 인코딩은 cp949라 한글 키가 깨지고, 깨진 키는 조용히
    # 빈 값으로 기록된다. stdin/파일 모두 UTF-8로 명시해서 읽는다.
    if args.json == "-":
        raw = sys.stdin.buffer.read().decode("utf-8")
    elif os.path.isfile(args.json):
        with open(args.json, encoding="utf-8") as f:
            raw = f.read()
    else:
        raw = args.json

    orders = json.loads(raw)
    if isinstance(orders, dict):
        orders = [orders]

    # 인코딩 깨짐이나 키 오타는 "빈 행 기록 성공"으로 조용히 끝난다. 그게 가장 나쁘므로
    # 받는사람 없는 행이 하나라도 있으면 아무것도 기록하지 않고 중단한다.
    bad = missing_name_rows(orders)
    if bad:
        print(f"❌ 기록 중단: {bad}번 행에 '받는사람'이 없습니다.")
        print(f"   읽어들인 키: {sorted(orders[bad[0] - 1].keys())}")
        print("   (키가 깨져 보이면 입력 파일 인코딩이 UTF-8인지 확인하세요)")
        sys.exit(1)

    # 날짜가 바뀐 뒤 첫 기록이면 구분용 빈 행을 한 줄 넣는다. 같은 날 추가 입력은 이어 붙인다.
    res = append_orders(sheet, orders, args.no_separator)
    if res["separator"]:
        print(f"📅 날짜 변경({res['prev_date']} → {res['date']}) — 구분용 빈 행 1줄 삽입")
    print(f"✅ {len(res['rows'])}건 기록 완료")
    for r in res["rows"]:
        print(f"  • {r[1]} | {r[3]} | {r[4]}")


def cmd_add_checked(sheet, args):
    """검증 3종(전화번호/시도/도로명주소)을 거쳐 통과분만 기록한다.

    RECORD 판정 → 정규화된 전화번호로 시트에 기록. 주소 API가 차단/불통이라 검증을
                  건너뛴 건은 시트엔 아무 표시도 하지 않고(비고 원본 유지), 콘솔에만
                  '주소 미검증' 목록으로 알려준다.
    HOLD 판정   → 시트에 기록하지 않고 backups/hold_queue_*.json 에 실패 사유와 함께
                  저장 + 콘솔에 사람 확인 큐로 출력. 주소 API가 찾아준 값은 참고용
                  '제안'으로만 보여주고 절대 자동 적용하지 않는다.
    """
    from validate import validate_order

    if args.json == "-":
        raw = sys.stdin.buffer.read().decode("utf-8")
    elif os.path.isfile(args.json):
        with open(args.json, encoding="utf-8") as f:
            raw = f.read()
    else:
        raw = args.json

    orders = json.loads(raw)
    if isinstance(orders, dict):
        orders = [orders]

    bad = missing_name_rows(orders)
    if bad:
        print(f"❌ 검증 중단: {bad}번 행에 '받는사람'이 없습니다.")
        sys.exit(1)

    to_record, to_hold = [], []
    for o in orders:
        result = validate_order({
            "phone": o.get("받는분전화번호", ""),
            "address": o.get("주소", ""),
        })
        if result["verdict"] == "RECORD":
            o = dict(o)
            if result["normalized_phone"]:
                o["받는분전화번호"] = result["normalized_phone"]
            # 주소 미검증은 시트에 남기지 않는다. 콘솔로만 알린다(아래 요약).
            to_record.append((o, result))
        else:
            to_hold.append((o, result))

    if to_record:
        res = append_orders(sheet, [o for o, _ in to_record], args.no_separator)
        if res["separator"]:
            print(f"📅 날짜 변경({res['prev_date']} → {res['date']}) — 구분용 빈 행 1줄 삽입")
        print(f"✅ RECORD {len(to_record)}건 기록 완료 (전화번호 정규화됨)")
        for o, _ in to_record:
            print(f"  • {o.get('받는사람')} | {o.get('받는분전화번호')} | {o.get('주소')}")
        # 주소 미검증(API 차단) 건은 시트에 표시하지 않고 여기서만 알린다.
        degraded = [o.get("받는사람") for o, r in to_record if r["notes"]]
        if degraded:
            print(f"\n⚠️ 주소 미검증(API 차단) {len(degraded)}건 — 시트엔 표시 안 함, 참고만:")
            print(f"   {', '.join(degraded)}")
    else:
        print("✅ RECORD 대상 없음")

    if to_hold:
        d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, f"hold_queue_{datetime.now():%Y%m%d_%H%M%S}.json")
        queue = [{**o, "_검증사유": r["reasons"], "_주소제안(참고용)": r["suggestion"]}
                 for o, r in to_hold]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(queue, f, ensure_ascii=False, indent=2)

        print(f"\n🟡 HOLD {len(to_hold)}건 — 시트에 기록하지 않고 사람 확인 큐로 뺌")
        print(f"   저장: {path}")
        for o, result in to_hold:
            print(f"  • {o.get('받는사람')} | {o.get('받는분전화번호')} | {o.get('주소')}")
            for reason in result["reasons"]:
                print(f"      - {reason}")
            if result["suggestion"]:
                print(f"      💡 juso 제안(자동적용 안 함, 참고만): {result['suggestion']}")
    else:
        print("🟡 HOLD 없음 — 전부 통과")


def cmd_count(sheet, args):
    data = data_rows(sheet)
    today = datetime.now().strftime("%Y-%m-%d")
    today_count = sum(1 for r in data if r and r[0].startswith(today))
    print(f"📊 전체 {len(data)}건 (오늘 {today_count}건)")


def cmd_recent(sheet, args):
    data = data_rows(sheet)
    recent = data[-args.n:] if data else []
    if not recent:
        print("📋 기록된 주문이 없어요.")
        return
    print(f"📋 최근 {len(recent)}건:")
    for r in recent:
        print(f"  • {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]}")


def cmd_search(sheet, args):
    """기록 전 중복 확인용. 받는사람/주소에 검색어가 들어간 행을 모두 보여준다."""
    q = args.keyword
    hits = [r for r in data_rows(sheet) if len(r) > 4 and (q in r[1] or q in r[4])]
    if not hits:
        print(f"🔍 '{q}' 와 겹치는 기존 기록 없음")
        return
    print(f"🔍 '{q}' 관련 기존 기록 {len(hits)}건 — 중복인지 확인하세요:")
    for r in hits:
        print(f"  • {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]}")


# ── 삭제 (실전 데이터 보호) ─────────────────────────────────────
#
# 삭제 계열은 전부 아래 순서를 강제한다:
#   1) 기본은 미리보기 — 무엇이 지워지는지 출력만 하고 시트는 건드리지 않는다
#   2) --commit 을 붙여야 실제 삭제
#   3) 실제 삭제 직전 무조건 CSV 백업 (실패하면 삭제하지 않는다)

def backup(sheet, tag="before-delete"):
    """시트 전체를 backups/ 에 CSV로 저장하고 경로를 돌려준다."""
    import csv
    rows = with_retry(lambda: sheet.get_all_values())
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{tag}_{datetime.now():%Y%m%d_%H%M%S}.csv")
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        csv.writer(f).writerows(rows)
    return path, max(len(rows) - 1, 0)


def show_targets(rows, title):
    print(f"{title} — 대상 {len([r for r in rows if not is_blank(r)])}건:")
    for r in rows:
        if is_blank(r):
            print("  · (날짜 구분용 빈 행)")
        else:
            print(f"  • {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]}")


def preview_guard(sheet, targets, args, what):
    """미리보기이면 True(=여기서 중단)를 돌려준다. 실행이면 백업 후 False."""
    show_targets([r for _, r in targets], what)
    if not args.commit:
        print("\n⚠️ 미리보기입니다. 시트는 그대로입니다.")
        print("   실제로 지우려면 같은 명령에 --commit 을 붙이세요.")
        return True
    path, n = backup(sheet)
    print(f"\n💾 삭제 전 백업: {path} ({n}건)")
    return False


def cmd_delete_last(sheet, args):
    """마지막 N '건'을 지운다. 날짜 구분용 빈 행은 건수에 세지 않는다."""
    all_rows = data_rows(sheet, include_blank=True)
    # (시트 행번호, 행) — 헤더가 1행이므로 데이터는 2행부터
    numbered = [(i + 2, r) for i, r in enumerate(all_rows)]
    if not any(not is_blank(r) for _, r in numbered):
        print("삭제할 데이터가 없어요.")
        return

    targets, deleted = [], 0
    for rownum, row in reversed(numbered):
        if deleted >= args.n:
            # 데이터 N건을 다 지운 뒤 위쪽에 남은 빈 행도 같이 정리한다.
            if is_blank(row):
                targets.append((rownum, row))
            break
        targets.append((rownum, row))
        if not is_blank(row):
            deleted += 1

    if preview_guard(sheet, targets, args, f"🗑 마지막 {deleted}건 삭제"):
        return
    for rownum, _ in targets:  # 아래에서 위로 지워야 행번호가 밀리지 않는다
        sheet.delete_rows(rownum)
    blanks = len(targets) - deleted
    print(f"🗑 마지막 {deleted}건 삭제 완료" + (f" (구분용 빈 행 {blanks}줄 포함)" if blanks else ""))


def cmd_delete_name(sheet, args):
    rows = sheet.get_all_values()
    targets = [(i, rows[i - 1]) for i in range(len(rows), 1, -1)
               if len(rows[i - 1]) > 1 and rows[i - 1][1] == args.name]
    if not targets:
        print(f"'{args.name}' 이름의 항목을 찾지 못했어요.")
        return
    if preview_guard(sheet, targets, args, f"🗑 '{args.name}' 삭제"):
        return
    for rownum, _ in targets:
        sheet.delete_rows(rownum)
    print(f"🗑 '{args.name}' {len(targets)}건 삭제 완료")


def cmd_clear(sheet, args):
    """전체 삭제. 실수 방지를 위해 현재 건수를 정확히 맞춰 적어야 실행된다."""
    data = data_rows(sheet)
    total = len(data)
    show_targets(data, "🗑 전체 삭제")
    if args.confirm_count != total:
        print(f"\n⚠️ 실행되지 않았습니다. 현재 {total}건입니다.")
        print(f"   정말 전부 지우려면: peach.py clear --confirm-count {total} --commit")
        return
    if not args.commit:
        print("\n⚠️ 미리보기입니다. 실제로 지우려면 --commit 을 붙이세요.")
        return
    path, n = backup(sheet, tag="before-clear")
    print(f"\n💾 삭제 전 백업: {path} ({n}건)")
    sheet.clear()
    sheet.append_row(HEADERS)
    print(f"🗑 전체 {total}건 삭제 완료")


def cmd_backup(sheet, args):
    path, n = backup(sheet, tag="manual")
    print(f"💾 백업 완료: {path} ({n}건)")


# ── 빈 칸 음영 ──────────────────────────────────────────────────
#
# 주소나 수량이 비어 있으면 그대로는 배송이 안 나간다. 시트를 눈으로 훑을 때
# 바로 보이도록 노란색으로 칠한다. 값이 채워지면 다시 실행해서 걷어내면 된다.

YELLOW = {"red": 1.0, "green": 0.95, "blue": 0.6}
WHITE = {"red": 1.0, "green": 1.0, "blue": 1.0}

# 비고는 비어 있는 게 정상이라 대상에서 뺀다. 나머지는 비면 배송에 지장이 있다.
CHECK_COLS = ["받는사람", "받는분전화번호", "수량", "주소", "보내는사람", "보내는분전화번호"]


def scan_blanks(sheet):
    """(A1표기, 행번호, 컬럼명, 받는사람, 비었는지) 목록. 날짜 구분용 빈 행은 제외."""
    rows = with_retry(lambda: sheet.get_all_values())
    out = []
    for rownum, row in enumerate(rows[1:], start=2):
        row = (row + [""] * len(HEADERS))[:len(HEADERS)]
        if is_blank(row):          # 날짜 구분용 빈 행 — 통째로 비어 있는 게 정상
            continue
        for col in CHECK_COLS:
            i = HEADERS.index(col)
            a1 = f"{chr(ord('A') + i)}{rownum}"
            out.append((a1, rownum, col, row[1], not row[i].strip()))
    return out


def cmd_highlight(sheet, args):
    cells = scan_blanks(sheet)
    blanks = [c for c in cells if c[4]]

    if not blanks and not args.clear:
        print("✅ 비어 있는 칸이 없습니다. 칠할 게 없어요.")
        return

    print(f"🟡 빈 칸 {len(blanks)}개:")
    for a1, _, col, name, _ in blanks:
        print(f"  • {a1}  {col} — {name}")

    formats = [{"range": a1, "format": {"backgroundColor": YELLOW}}
               for a1, _, _, _, _ in blanks]
    if args.clear:
        # 값이 채워진 칸의 음영을 걷어낸다. 다시 실행하면 최신 상태로 맞춰진다.
        filled = [c for c in cells if not c[4]]
        formats += [{"range": a1, "format": {"backgroundColor": WHITE}}
                    for a1, _, _, _, _ in filled]
        print(f"🧽 채워진 칸 {len(filled)}개의 음영을 걷어냅니다.")

    if not args.commit:
        print("\n⚠️ 미리보기입니다. 시트는 그대로입니다.")
        print("   실제로 칠하려면 같은 명령에 --commit 을 붙이세요.")
        return

    with_retry(lambda: sheet.batch_format(formats))
    print(f"\n🟡 {len(blanks)}칸 음영 완료" + (f" (+{len(formats) - len(blanks)}칸 해제)" if args.clear else ""))


def cmd_restore(sheet, args):
    """백업 CSV로 시트를 되돌린다. 되돌리기 직전 현재 상태도 백업한다."""
    import csv
    with open(args.csv, encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    if not rows or rows[0] != HEADERS:
        print(f"❌ 헤더가 맞지 않는 파일입니다: {rows[0] if rows else '(빈 파일)'}")
        print(f"   기대: {HEADERS}")
        sys.exit(1)

    print(f"↩️ 복원 대상: {args.csv} ({len(rows) - 1}건) — 현재 시트 내용을 이걸로 덮어씁니다.")
    if not args.commit:
        print("⚠️ 미리보기입니다. 실제로 복원하려면 --commit 을 붙이세요.")
        return
    path, n = backup(sheet, tag="before-restore")
    print(f"💾 복원 전 현재 상태 백업: {path} ({n}건)")
    sheet.clear()
    with_retry(lambda: sheet.append_rows(rows, value_input_option="RAW"))
    print(f"↩️ 복원 완료: {len(rows) - 1}건")


def main():
    p = argparse.ArgumentParser(description="복숭아 주문 시트 CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="주문 JSON 기록")
    a.add_argument("json", help="주문 JSON 배열, JSON 파일 경로, 또는 '-' (stdin)")
    a.add_argument("--no-separator", action="store_true",
                   help="날짜가 바뀌어도 구분용 빈 행을 넣지 않음")
    a.set_defaults(func=cmd_add)

    ac = sub.add_parser("add-checked",
                         help="검증 3종(전화번호/시도/도로명주소) 통과분만 기록, 나머지는 HOLD 큐로")
    ac.add_argument("json", help="주문 JSON 배열, JSON 파일 경로, 또는 '-' (stdin)")
    ac.add_argument("--no-separator", action="store_true",
                     help="날짜가 바뀌어도 구분용 빈 행을 넣지 않음")
    ac.set_defaults(func=cmd_add_checked)

    c = sub.add_parser("count", help="건수 조회")
    c.set_defaults(func=cmd_count)

    r = sub.add_parser("recent", help="최근 주문 조회")
    r.add_argument("n", nargs="?", type=int, default=5)
    r.set_defaults(func=cmd_recent)

    s = sub.add_parser("search", help="받는사람/주소로 기존 기록 검색 (중복 확인)")
    s.add_argument("keyword")
    s.set_defaults(func=cmd_search)

    d = sub.add_parser("delete-last", help="마지막 N건 삭제 (기본 미리보기)")
    d.add_argument("n", nargs="?", type=int, default=1)
    d.add_argument("--commit", action="store_true", help="실제로 삭제")
    d.set_defaults(func=cmd_delete_last)

    dn = sub.add_parser("delete-name", help="받는사람 이름으로 삭제 (기본 미리보기)")
    dn.add_argument("name")
    dn.add_argument("--commit", action="store_true", help="실제로 삭제")
    dn.set_defaults(func=cmd_delete_name)

    cl = sub.add_parser("clear", help="전체 삭제 (건수를 정확히 적어야 실행)")
    cl.add_argument("--confirm-count", type=int, default=-1, dest="confirm_count",
                    help="현재 건수와 정확히 일치해야 실행됨")
    cl.add_argument("--commit", action="store_true", help="실제로 삭제")
    cl.set_defaults(func=cmd_clear)

    b = sub.add_parser("backup", help="현재 시트를 CSV로 백업")
    b.set_defaults(func=cmd_backup)

    hl = sub.add_parser("highlight", help="빈 칸을 노란색으로 음영 (기본 미리보기)")
    hl.add_argument("--clear", action="store_true",
                    help="값이 채워진 칸의 음영은 걷어냄 (다시 돌리면 최신 상태로 맞춰짐)")
    hl.add_argument("--commit", action="store_true", help="실제로 서식 적용")
    hl.set_defaults(func=cmd_highlight)

    rs = sub.add_parser("restore", help="백업 CSV로 복원 (기본 미리보기)")
    rs.add_argument("csv", help="백업 CSV 경로")
    rs.add_argument("--commit", action="store_true", help="실제로 복원")
    rs.set_defaults(func=cmd_restore)

    args = p.parse_args()
    sheet = get_sheet()
    if args.cmd in ("add", "add-checked"):
        init_sheet(sheet)
    args.func(sheet, args)


if __name__ == "__main__":
    main()
