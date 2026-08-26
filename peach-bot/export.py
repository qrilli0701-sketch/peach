"""출고 — 시트 내용을 택배업체에 보낼 파일로 내보낸다.

택배사 고정 양식이 없어서 **시트 열을 그대로** 쓴다. 하는 일은 세 가지:
  1. 날짜 범위로 자르기 (그날 나갈 것만)
  2. 내보내기 전 빈 칸 막기 — 주소·수량이 빈 채로 택배사에 넘어가면 배송이 안 나간다
  3. .xlsx / .csv 로 저장

박스 수·금액 요약도 여기서 낸다. 출고 직전에 확인하는 숫자라 같이 둔다.
"""
import io
import re
import csv
from math import ceil

HEADERS = ["입력시각", "받는사람", "받는분전화번호", "수량", "주소",
           "보내는사람", "보내는분전화번호", "비고"]

# 비고는 비어 있는 게 정상. 나머지가 비면 배송에 지장이 있다. (peach.py 와 같은 기준)
REQUIRED_COLS = ["받는사람", "받는분전화번호", "수량", "주소"]

BOX_PRICE = 40_000
SHIPPING_PRICE = 5_000
BOXES_PER_SHIPMENT = 2   # 2박스까지 택배 한 건으로 묶음

QTY_RE = re.compile(r"\d+")


def parse_qty(text):
    """'2박스' → 2. 숫자를 못 찾으면 None (= 수량 불명, 사람이 봐야 함)."""
    m = QTY_RE.search(text or "")
    return int(m.group()) if m else None


def price_of(boxes):
    """박스당 40,000 + 택배 5,000(2박스까지 묶음). 1박스=45,000, 2박스=85,000."""
    if not boxes or boxes < 1:
        return 0
    return boxes * BOX_PRICE + ceil(boxes / BOXES_PER_SHIPMENT) * SHIPPING_PRICE


def is_blank_row(row):
    return not any((c or "").strip() for c in row)


def pad(row):
    return (list(row) + [""] * len(HEADERS))[:len(HEADERS)]


def row_date(row):
    """입력시각 앞 10자리(YYYY-MM-DD). 없으면 빈 문자열."""
    return (row[0] or "")[:10] if row else ""


def number_rows(rows, first_row=2):
    """시트 행번호를 붙인다. [(행번호, 행), ...] — 헤더가 1행이라 데이터는 2행부터."""
    return [(i + first_row, pad(r)) for i, r in enumerate(rows)]


def filter_numbered(numbered, start=None, end=None):
    """행번호를 유지한 채 날짜로 자른다. 날짜 구분용 빈 행은 항상 제외.

    행번호를 끝까지 들고 다니는 이유: 내용이 똑같은 행이 둘 있을 때(같은 사람이
    같은 주소로 두 번 시켰을 때) 값으로 되찾으려 하면 엉뚱한 행을 짚는다.
    """
    out = []
    for rownum, r in numbered:
        if is_blank_row(r):
            continue
        d = row_date(r)
        if start and d < start:
            continue
        if end and d > end:
            continue
        out.append((rownum, r))
    return out


def filter_by_date(rows, start=None, end=None):
    """날짜 구분용 빈 행은 항상 제외. start/end 는 'YYYY-MM-DD' (포함)."""
    return [r for _, r in filter_numbered(number_rows(rows), start, end)]


def blocking_gaps(rows):
    """내보내기를 막아야 할 빈 칸 목록. [(행번호, 열이름, 받는사람), ...]

    행번호는 넘겨받은 rows 안에서의 순번이 아니라 각 행에 붙여둔 시트 행번호를 쓴다.
    (server 가 (rownum, row) 쌍으로 넘긴다)
    """
    gaps = []
    for rownum, row in rows:
        row = pad(row)
        for col in REQUIRED_COLS:
            if not row[HEADERS.index(col)].strip():
                gaps.append({"row": rownum, "col": col, "name": row[1]})
    return gaps


def summarize(rows):
    """건수·박스·금액 요약. 수량을 못 읽은 건은 따로 센다(금액에서 빠짐)."""
    boxes, unknown, amount = 0, 0, 0
    for row in rows:
        q = parse_qty(pad(row)[HEADERS.index("수량")])
        if q is None:
            unknown += 1
            continue
        boxes += q
        amount += price_of(q)
    return {
        "건수": len(rows),
        "박스": boxes,
        "금액": amount,
        "수량불명": unknown,
    }


# ── 파일 만들기 ─────────────────────────────────────────────

def to_csv(rows, headers=None):
    """엑셀에서 바로 열리도록 UTF-8 BOM. (peach.py 백업과 같은 방식)"""
    headers = headers or HEADERS
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(headers)
    w.writerows(pad(r) for r in rows)
    return buf.getvalue().encode("utf-8-sig")


def to_xlsx(rows, headers=None, sheet_title="출고"):
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill
    from openpyxl.utils import get_column_letter

    headers = headers or HEADERS
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_title

    ws.append(headers)
    head_fill = PatternFill("solid", fgColor="FFF2CC")
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")

    for r in rows:
        ws.append(pad(r))

    # 전화번호가 숫자로 인식돼 앞자리 0이 날아가는 걸 막는다. 택배사에서 제일 흔한 사고.
    for col_name in ("받는분전화번호", "보내는분전화번호"):
        letter = get_column_letter(headers.index(col_name) + 1)
        for cell in ws[letter][1:]:
            cell.number_format = "@"

    widths = {"입력시각": 19, "받는사람": 12, "받는분전화번호": 16, "수량": 8,
              "주소": 52, "보내는사람": 12, "보내는분전화번호": 16, "비고": 24}
    for i, h in enumerate(headers, start=1):
        ws.column_dimensions[get_column_letter(i)].width = widths.get(h, 14)

    ws.freeze_panes = "A2"

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
