"""붙여넣기 텍스트 → 주문 JSON.

UI 의 '받기' 화면에서 쓴다. 대화창에서 Claude 가 만든 JSON 배열을 그대로 받아도 되고,
주문서에서 복사한 날것의 텍스트를 받아도 된다.

**이 모듈은 교정하지 않는다.** 오타로 보여도 원문 그대로 옮기고, 확신이 없으면
빈 값으로 두고 `_확인필요` 에 사유를 적어 화면에서 노란 칸으로 보이게 한다.
(운영 규칙 7 — 자동 교정 금지)

형식을 통째로 하나 고르지 않고 **줄마다** 판단한다. 라벨 줄과 슬래시 줄이 섞여
와도 어느 쪽도 버리지 않는다.

파싱은 어디까지나 '초벌'이다. 최종 판단은 화면의 표에서 사람이 한다.
"""
import re
import json

FIELDS = ["받는사람", "받는분전화번호", "수량", "주소",
          "보내는사람", "보내는분전화번호", "비고"]

# 구분자에 언더스코어를 넣은 이유: 실제 주문서에 010_3273_1229 형태로 온다.
# 정규화 규칙(SKILL.md 2)은 이걸 다루는데 정작 파서가 못 알아봐서 비고로 새어나갔다.
PHONE_RE = re.compile(r"0\d{1,2}[-._\s]?\d{3,4}[-._\s]?\d{4}")
# '010...1234' 처럼 가운데를 가린 표기. 이건 전화번호로 쓰면 안 된다(운영 규칙).
MASKED_PHONE_RE = re.compile(r"0\d{1,2}\s*[.·*x…]{2,}\s*\d{3,4}")
QTY_RE = re.compile(r"(\d+)\s*(?:박스|BOX|box|Box|상자|개|짝)")
# 전화번호처럼 생겼지만 자릿수가 안 맞는 것('010-777-888'). 비고로 흘려보내면
# 사람이 못 보고 지나간다. 전화 칸에 원문 그대로 넣어서 검증 레이어가 빨갛게 잡게 한다.
LOOSE_PHONE_RE = re.compile(r"^0\d{1,2}[-._\s]?\d{2,4}[-._\s]?\d{2,4}$")

# 주소로 보이는 조각: 행정구역/도로명 꼬리표를 갖고 어느 정도 길이가 있는 것
ADDR_HINT = re.compile(r"(시|도|군|구|읍|면|리|동|로|길|가|번지|아파트|APT|빌라|타운)")
ADDR_NUM = re.compile(r"\d")

# 라벨이 붙은 형식('받는분: 홍길동') 대응. 긴 라벨을 먼저 봐야
# '보내는분전화' 가 '전화' 로 잘못 잡히지 않는다.
LABELS = {
    "받는사람": ["받는사람", "받는분성함", "받는분", "받는이", "수취인", "수령인",
                 "고객명", "성함", "이름"],
    "받는분전화번호": ["받는분전화번호", "받는분연락처", "받는분전화", "받는분번호",
                       "수취인연락처", "연락처", "전화번호", "휴대폰", "핸드폰", "전화"],
    "수량": ["수량", "박스수", "개수", "갯수", "박스"],
    "주소": ["배송주소", "배송지", "주소지", "주소"],
    "보내는사람": ["보내는사람", "보내는분성함", "보내는분", "보내는이", "발송인",
                   "송하인", "주문자"],
    "보내는분전화번호": ["보내는분전화번호", "보내는분연락처", "보내는분전화",
                         "발송인연락처", "발송인전화", "보내는번호"],
    "비고": ["비고", "요청사항", "메모", "참고"],
}
# (라벨, 필드) 를 라벨 길이 내림차순으로 — 긴 것 우선 매칭
LABEL_PAIRS = sorted(
    ((label, field) for field, labels in LABELS.items() for label in labels),
    key=lambda p: -len(p[0]))

LABEL_LINE_RE = re.compile(r"^\s*[\-•*]?\s*([가-힣A-Za-z ]{1,12})\s*[:：]\s*(.*)$")


def _blank_order():
    return {f: "" for f in FIELDS}


# ── 조각 분류 ────────────────────────────────────────────────

def looks_like_phone(s):
    return bool(PHONE_RE.search(s))


def looks_like_masked_phone(s):
    return bool(MASKED_PHONE_RE.search(s))


def looks_like_bad_phone(s):
    """전화번호 자리에 들어갈 의도였지만 자릿수가 어긋난 값."""
    s = s.strip()
    if not LOOSE_PHONE_RE.match(s):
        return False
    return 8 <= len(re.sub(r"\D", "", s)) <= 12


def looks_like_qty(s):
    s = s.strip()
    if QTY_RE.search(s):
        return True
    return s.isdigit() and 0 < int(s) < 100


def looks_like_address(s):
    s = s.strip()
    if len(s) < 6:
        return False
    return bool(ADDR_HINT.search(s)) and bool(ADDR_NUM.search(s))


def looks_like_name(s):
    s = s.strip()
    return 1 < len(s) <= 12 and not any(ch.isdigit() for ch in s)


# ── 형식 1: JSON 배열 (대화창에서 만든 결과를 그대로 붙여넣기) ──

def try_json(text):
    text = text.strip()
    if not text or text[0] not in "[{":
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return None
    out = []
    for item in data:
        if not isinstance(item, dict):
            return None
        o = _blank_order()
        for k, v in item.items():
            if k in FIELDS:
                o[k] = ("" if v is None else str(v)).strip()
        o["_확인필요"] = []
        o["_출처"] = "JSON"
        out.append(o)
    return out


# ── 한 줄을 조각내 형태로 판별 ──────────────────────────────

SPLIT_RE = re.compile(r"\s*[/|]\s*|\t+|\s{3,}")


def parse_freeform_line(line):
    """한 줄을 조각내고 각 조각이 무엇인지 형태로 판별한다.

    자리(순서)를 믿지 않고 형태를 본다. 주문서마다 열 순서가 달라서
    순서를 믿으면 이름 칸에 주소가 들어가는 사고가 난다.
    """
    parts = [p.strip() for p in SPLIT_RE.split(line) if p.strip()]
    if len(parts) < 2:
        parts = [line.strip()]

    o = _blank_order()
    o["_확인필요"] = []
    leftovers = []

    for p in parts:
        if looks_like_masked_phone(p):
            # 가려진 번호는 절대 채우지 않는다 — 빈 칸으로 두고 사람이 확인.
            o["_확인필요"].append(f"전화번호가 가려져 있음: {p}")
            continue
        if looks_like_phone(p) or looks_like_bad_phone(p):
            if not looks_like_phone(p):
                o["_확인필요"].append(f"전화번호 자릿수가 맞지 않음: {p}")
            if not o["받는분전화번호"]:
                o["받는분전화번호"] = p
            elif not o["보내는분전화번호"]:
                o["보내는분전화번호"] = p
            else:
                leftovers.append(p)
            continue
        if looks_like_address(p):
            o["주소"] = (o["주소"] + " " + p).strip() if o["주소"] else p
            continue
        if looks_like_qty(p) and not o["수량"]:
            o["수량"] = p
            continue
        if looks_like_name(p):
            if not o["받는사람"]:
                o["받는사람"] = p
            elif not o["보내는사람"]:
                o["보내는사람"] = p
            else:
                leftovers.append(p)
            continue
        leftovers.append(p)

    if leftovers:
        o["비고"] = " ".join(leftovers)
    o["_출처"] = "자유형식"
    return o


# ── 형식 2·3: 라벨 줄과 자유 형식 줄이 섞여 있어도 줄 단위로 읽는다 ──
#
# 예전에는 "라벨 형식이면 전부 라벨로, 아니면 전부 자유형식으로" 골랐다. 그러면
# 슬래시 줄과 라벨 줄이 한 덩어리에 섞여 올 때 한쪽이 통째로 사라진다. 주문이
# 소리 없이 증발하는 건 최악이라, 형식을 통째로 고르지 않고 줄마다 판단한다.

def match_label(raw_label):
    key = raw_label.replace(" ", "")
    for label, field in LABEL_PAIRS:
        if key == label or key.startswith(label) or label in key:
            return field
    return None


def is_order_line(line):
    """라벨이 없어도 그 자체로 한 건을 이루는 줄인지.

    전화번호가 있거나, 구분자로 세 조각 이상 나뉘면 독립된 주문 줄로 본다.
    그 외(주소가 길어 줄바꿈된 것 등)는 직전 줄의 이어짐으로 취급한다.
    """
    if PHONE_RE.search(line) or MASKED_PHONE_RE.search(line):
        return True
    return len([p for p in SPLIT_RE.split(line) if p.strip()]) >= 3


def parse_mixed(text):
    """라벨 줄·자유 형식 줄이 섞인 텍스트를 한 번에 읽는다. (orders, 쓰인 형식들)"""
    orders, used = [], set()
    cur, last_field = None, None

    def close():
        nonlocal cur, last_field
        if cur and any(cur.get(f) for f in FIELDS):
            cur["_출처"] = "라벨"
            used.add("라벨 형식")
            orders.append(cur)
        cur, last_field = None, None

    for line in text.splitlines():
        if not line.strip():
            close()
            continue

        m = LABEL_LINE_RE.match(line)
        field = match_label(m.group(1)) if m else None

        if field:
            # 받는사람이 다시 나오면 새 건이 시작된 것으로 본다.
            if cur and field == "받는사람" and cur.get("받는사람"):
                close()
            if cur is None:
                cur = _blank_order()
                cur["_확인필요"] = []
            cur[field] = m.group(2).strip()
            last_field = field
            continue

        if is_order_line(line):
            close()
            o = parse_freeform_line(line)
            if any(o.get(f) for f in FIELDS):
                used.add("자유 형식")
                orders.append(o)
            continue

        # 라벨도 아니고 독립된 주문 줄도 아니면 직전 값의 이어짐(주소 줄바꿈 등)
        if cur and last_field:
            cur[last_field] = (cur[last_field] + " " + line.strip()).strip()
        elif orders and orders[-1].get("주소"):
            orders[-1]["주소"] = (orders[-1]["주소"] + " " + line.strip()).strip()

    close()
    return orders, used


# ── 진입점 ──────────────────────────────────────────────────

def flag_gaps(order):
    """비어 있어서 배송에 지장이 있는 칸을 짚어준다. 채우지는 않는다."""
    notes = order.setdefault("_확인필요", [])
    if not order.get("받는사람"):
        notes.append("받는사람 없음")
    if not order.get("받는분전화번호"):
        notes.append("받는분 전화번호 없음")
    if not order.get("주소"):
        notes.append("주소 없음")
    if not order.get("수량"):
        notes.append("수량 없음")
    return order


def parse(text):
    """텍스트를 주문 배열로. 어떤 형식으로 읽었는지도 같이 돌려준다."""
    text = (text or "").strip()
    if not text:
        return {"orders": [], "format": "빈 입력"}

    orders = try_json(text)
    if orders:
        for o in orders:
            flag_gaps(o)
        return {"orders": orders, "format": "JSON"}

    orders, used = parse_mixed(text)
    if not orders:
        return {"orders": [], "format": "인식 실패"}
    for o in orders:
        flag_gaps(o)
    label = " + ".join(sorted(used)) if len(used) > 1 else next(iter(used))
    return {"orders": orders, "format": label}
