"""카톡 대화 내보내기(.txt) → 보낸사람별 주문 묶음.

주문은 카톡으로 온다. 양식이 없고, 한 건이 여러 메시지에 흩어지고, 잡담이 섞인다.
그걸 주문으로 **해석하는 건 기계가 못 한다** — 그건 Claude 가 읽는다.
이 모듈이 하는 건 그 앞 단계, 즉 **구조화**다:

  1. 카톡 내보내기 형식(안드로이드/아이폰/PC)을 파싱해 (시각, 보낸사람, 내용) 으로 쪼갠다
  2. 같은 사람이 연달아 보낸 메시지를 한 묶음으로 합친다 (한 주문이 여러 줄에 걸치므로)
  3. **보낸사람 이름을 보내는사람 후보로 붙인다** — 손글씨로는 못 읽던 값이 여기선 공짜다
  4. 사진이 있던 자리, '총 N박스' 같은 합계 표현을 표시해 준다

이렇게 묶어 놓으면 사람이 카톡을 하나씩 옮길 필요가 없다. 하루치를 한 번에 내보내
이 모듈을 태우고, Claude 가 묶음 단위로 읽는다.

사용법:
    python kakao.py <내보낸파일.txt>            보낸사람별 묶음을 사람이 읽기 좋게 출력
    python kakao.py <파일.txt> --json           묶음을 JSON 으로 (다른 도구에 넘길 때)
    python kakao.py <파일.txt> --since 2026-08-26   그 날짜 이후만
"""
import re
import sys
import json
import argparse
from datetime import datetime

# 카톡 내보내기 형식은 기기마다 다르다. 셋 다 받는다.
PATTERNS = [
    # 안드로이드: 2026년 8월 26일 오전 9:14, 김순자 : 내용
    re.compile(r"^(?P<y>\d{4})년\s*(?P<mo>\d{1,2})월\s*(?P<d>\d{1,2})일\s+"
               r"(?P<ap>오전|오후)\s*(?P<h>\d{1,2}):(?P<mi>\d{2}),\s*"
               r"(?P<who>.+?)\s*:\s(?P<text>.*)$"),
    # 아이폰: 2026. 8. 26. 오전 9:14, 김순자 : 내용
    re.compile(r"^(?P<y>\d{4})\.\s*(?P<mo>\d{1,2})\.\s*(?P<d>\d{1,2})\.\s+"
               r"(?P<ap>오전|오후)\s*(?P<h>\d{1,2}):(?P<mi>\d{2}),\s*"
               r"(?P<who>.+?)\s*:\s(?P<text>.*)$"),
    # PC: [김순자] [오전 9:14] 내용
    re.compile(r"^\[(?P<who>[^\]]+)\]\s*\[(?P<ap>오전|오후)\s*"
               r"(?P<h>\d{1,2}):(?P<mi>\d{2})\]\s*(?P<text>.*)$"),
]

# PC 버전은 날짜가 따로 한 줄로 나온다: --------------- 2026년 8월 26일 화요일 ---------------
DATE_LINE = re.compile(r"-{3,}\s*(?P<y>\d{4})년\s*(?P<mo>\d{1,2})월\s*(?P<d>\d{1,2})일.*-{3,}")

# 주문과 무관한 시스템 메시지
SYSTEM = re.compile(r"(님이 (들어왔|나갔)습니다|삭제된 메시지입니다|"
                    r"채팅방에 초대했습니다|저장한 날짜)")

# 사진이 있던 자리. 캡처를 따로 받아야 하므로 표시해 둔다.
MEDIA = re.compile(r"^\s*(사진|사진 \d+장|동영상|이모티콘|음성메시지|파일: .*)\s*$")

# '총 8박스' 같은 합계. 개별 수량 합과 맞는지 검산할 대상.
TOTAL = re.compile(r"(총|합계|모두)\s*(\d+)\s*(박스|개|상자)")

PHONE = re.compile(r"0\d{1,2}[-._\s]?\d{3,4}[-._\s]?\d{4}")
MASKED = re.compile(r"0\d{1,2}\s*[.·*x…]{2,}\s*\d{3,4}")


def parse_lines(text):
    """내보낸 텍스트를 (datetime|None, 보낸사람, 내용) 목록으로. 순서 유지."""
    msgs, cur_date = [], None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue

        d = DATE_LINE.match(line.strip())
        if d:
            cur_date = (int(d["y"]), int(d["mo"]), int(d["d"]))
            continue

        for pat in PATTERNS:
            m = pat.match(line)
            if not m:
                continue
            g = m.groupdict()
            if SYSTEM.search(g["text"]):
                break                      # 시스템 메시지는 버린다
            hour = int(g["h"]) % 12 + (12 if g["ap"] == "오후" else 0)
            if "y" in g and g.get("y"):
                date = (int(g["y"]), int(g["mo"]), int(g["d"]))
            else:
                date = cur_date            # PC 형식은 위쪽 날짜 줄을 따른다
            when = datetime(*date, hour, int(g["mi"])) if date else None
            msgs.append({"when": when, "who": g["who"].strip(), "text": g["text"].strip()})
            break
        else:
            # 어느 형식에도 안 맞는 줄. 시스템 안내문일 수도, 긴 메시지의 줄바꿈일 수도 있다.
            #
            # 안내문을 직전 메시지에 붙이면 그 메시지 전체가 시스템 메시지로 판정돼
            # 같이 버려진다. 실제 주문 한 줄이 그렇게 통째로 사라진 적이 있어,
            # 붙이기 전에 먼저 걸러낸다.
            if SYSTEM.search(line):
                continue
            if msgs:
                msgs[-1]["text"] += "\n" + line.strip()

    return [m for m in msgs if m["text"]]


def group(msgs, gap_minutes=20):
    """같은 사람이 연달아 보낸 메시지를 한 묶음으로. 한 주문이 여러 줄에 걸치기 때문.

    사이에 다른 사람이 끼거나 gap_minutes 이상 벌어지면 다른 묶음으로 본다.
    """
    out = []
    for m in msgs:
        last = out[-1] if out else None
        same_person = last and last["보낸사람"] == m["who"]
        close_in_time = (
            same_person and last["_last_when"] and m["when"]
            and (m["when"] - last["_last_when"]).total_seconds() <= gap_minutes * 60)
        if same_person and (close_in_time or not m["when"]):
            last["메시지"].append(m["text"])
            last["_last_when"] = m["when"] or last["_last_when"]
            continue
        out.append({
            "보낸사람": m["who"],
            "시각": m["when"].strftime("%Y-%m-%d %H:%M") if m["when"] else "",
            "메시지": [m["text"]],
            "_last_when": m["when"],
        })

    for g in out:
        g.pop("_last_when", None)
        body = "\n".join(g["메시지"])
        g["사진"] = sum(1 for t in g["메시지"] if MEDIA.match(t))
        g["전화번호"] = PHONE.findall(body)
        g["가려진번호"] = MASKED.findall(body)
        total = TOTAL.search(body)
        g["합계표현"] = total.group(0) if total else ""
        # 주문으로 볼 만한 신호가 하나도 없으면(전화도 사진도 수량도 없음) 잡담일 가능성.
        # 버리지는 않는다 — 판단은 사람과 Claude 가 한다.
        g["주문신호"] = bool(g["전화번호"] or g["가려진번호"] or g["사진"]
                              or re.search(r"\d+\s*(박스|개|상자)", body))
    return out


def render(groups):
    """사람이 읽기 좋은 형태. 이 출력을 그대로 Claude 에게 넘기면 된다."""
    lines = []
    orders = [g for g in groups if g["주문신호"]]
    chat = len(groups) - len(orders)
    lines.append(f"카톡 묶음 {len(groups)}개 — 주문으로 보이는 것 {len(orders)}개, "
                 f"신호 없는 것 {chat}개")
    lines.append("")
    for i, g in enumerate(groups, 1):
        mark = "" if g["주문신호"] else "  (주문 신호 없음 — 잡담일 수 있음)"
        lines.append(f"[{i}] {g['시각']}  보낸사람: {g['보낸사람']}{mark}")
        for t in g["메시지"]:
            for j, sub in enumerate(t.splitlines()):
                lines.append(f"      {'│' if j else '·'} {sub}")
        flags = []
        if g["사진"]:
            flags.append(f"📷 사진 {g['사진']}장 — 캡처를 따로 받아야 함")
        if g["가려진번호"]:
            flags.append(f"⚠️ 가려진 번호 {g['가려진번호']} — 채우지 말 것")
        if g["합계표현"]:
            flags.append(f"🧮 '{g['합계표현']}' — 개별 수량 합과 검산 필요")
        for f in flags:
            lines.append(f"      {f}")
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="카톡 내보내기 → 보낸사람별 주문 묶음")
    ap.add_argument("file", help="카톡에서 내보낸 .txt 경로")
    ap.add_argument("--json", action="store_true", help="JSON 으로 출력")
    ap.add_argument("--since", help="이 날짜(YYYY-MM-DD) 이후만")
    ap.add_argument("--gap", type=int, default=20,
                    help="같은 사람의 메시지를 한 묶음으로 볼 최대 간격(분). 기본 20")
    args = ap.parse_args()

    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    with open(args.file, encoding="utf-8") as f:
        groups = group(parse_lines(f.read()), args.gap)

    if args.since:
        groups = [g for g in groups if g["시각"][:10] >= args.since]

    print(json.dumps(groups, ensure_ascii=False, indent=2) if args.json
          else render(groups))


if __name__ == "__main__":
    main()
