"""주문접수(확인된 주문) → 27년주문(메인 기록) 이동 도구.

흐름 (SKILL: .claude/skills/peach-move/SKILL.md)
  1. prepare : 주문접수에서 상태가 '확인'인 줄을 27년주문 형식으로 변환해 JSON 으로 저장한다. 시트는 쓰지 않는다.
  2. (감사 에이전트 2명이 변환 결과를 점수로 검증, 둘 다 90점 이상 합의한 줄만 통과)
  3. apply   : 합의 통과 + 사용자가 "넣어"라고 한 줄만 27년주문 에 추가하고, 주문접수 상태를 '완료'로 바꾼다.

사용법:
    python move_orders.py prepare [--out FILE]
    python move_orders.py apply FILE --yes
"""
import os
import re
import sys
import json
import argparse
from datetime import datetime

import peach  # with_retry, HEADERS, FIELDS, last_record_date, data_rows 재사용

QUEUE_TAB = "주문접수"
MAIN_TAB = "27년주문"   # 내년(2027) 시즌 메인 기록 탭 (2026 시즌 기록은 시트1 이라 건드리지 않는다)
# 주문접수 열(1부터): A 접수시각 B 받는사람 C 받는분전화 D 수량 E 주소 F 보내는사람 G 보내는분전화 H 비고 I 상태 J 주문받은사람 K 확인시각 L 메모 M 수정기록
C_TIME, C_NAME, C_PHONE, C_QTY, C_ADDR, C_SENDER, C_SPHONE, C_NOTE, C_STATUS, C_BY, C_AT = range(1, 12)

TAG_RE = re.compile(r"\s*\[(?:메일|미비):[^\]]*\]")


def open_spreadsheet():
    peach.load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    sh = peach.get_sheet()
    return sh.spreadsheet


def hyphen_phone(p):
    """숫자 11자리면 010-1234-5678 형식. 그 외는 원문 유지(자동 보정 금지)."""
    d = re.sub(r"[^0-9]", "", p or "")
    if len(d) == 11 and (p or "").replace("-", "").replace(" ", "").isdigit():
        return f"{d[:3]}-{d[3:7]}-{d[7:]}"
    return (p or "").strip()


def clean_note(note):
    """비고에서 시스템 태그([메일:..], [미비:..])만 제거. 손님이 쓴 글은 그대로."""
    return TAG_RE.sub("", note or "").strip()


def norm_key(name, phone, sphone):
    dig = lambda s: re.sub(r"[^0-9]", "", s or "")
    return (re.sub(r"\s+", "", name or ""), dig(phone), dig(sphone))


def build_candidates(ss, queue_tab=QUEUE_TAB, main_tab=MAIN_TAB):
    q = ss.worksheet(queue_tab).get_all_values()
    main = peach.data_rows(ss.worksheet(main_tab))
    main_index = {}
    for i, r in enumerate(main):
        r = r + [""] * 8
        main_index.setdefault(norm_key(r[1], r[2], r[6]), []).append(
            {"입력시각": r[0], "받는사람": r[1], "수량": r[3], "주소": r[4], "보내는사람": r[5], "비고": r[7]})

    cands, seen = [], {}
    for idx, r in enumerate(q[1:], start=2):
        r = r + [""] * 13
        if r[C_STATUS - 1].strip() != "확인":
            continue
        raw = {"행": idx, "접수시각": r[0], "받는사람": r[1], "받는분전화번호": r[2], "수량": r[3], "주소": r[4],
               "보내는사람": r[5], "보내는분전화번호": r[6], "비고": r[7], "주문받은사람": r[9], "확인시각": r[10]}
        out = {"입력시각": r[0], "받는사람": r[1], "받는분전화번호": hyphen_phone(r[2]), "수량": r[3].strip(),
               "주소": r[4], "보내는사람": r[5], "보내는분전화번호": hyphen_phone(r[6]), "비고": clean_note(r[7])}
        key = norm_key(r[1], r[2], r[6])
        flags = []
        for k in ("받는사람", "받는분전화번호", "수량", "주소", "보내는사람", "보내는분전화번호"):
            if not out[k]:
                flags.append(f"빈 칸: {k}")
        for k in ("받는분전화번호", "보내는분전화번호"):
            if out[k] and not re.fullmatch(r"010-\d{4}-\d{4}", out[k]):
                flags.append(f"전화 형식 확인: {k}={out[k]}")
        if out["수량"] and not re.fullmatch(r"[1-9]\d*", out["수량"]):
            flags.append(f"수량이 숫자가 아님: {out['수량']}")
        if "[미비:" in r[7]:
            flags.append("주문접수에서 미비 표시가 있던 줄")
        dup_main = main_index.get(key, [])
        if dup_main:
            flags.append(f"27년주문에 같은 받는사람·전화·보내는분전화 기록 {len(dup_main)}건")
        if key in seen:
            flags.append(f"이번 묶음 안에서 {seen[key]}행과 겹침")
        seen.setdefault(key, idx)
        cands.append({"원본": raw, "변환": out, "플래그": flags, "기존기록중복": dup_main})
    return cands


def cmd_prepare(args):
    ss = open_spreadsheet()
    cands = build_candidates(ss, args.queue_tab, args.main_tab)
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups",
                                   f"move_prepare_{datetime.now():%Y%m%d_%H%M%S}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"queue_tab": args.queue_tab, "main_tab": args.main_tab, "rows": cands}, f,
                  ensure_ascii=False, indent=2)
    print(f"✅ 옮길 후보 {len(cands)}건 → {out}")
    for c in cands:
        t = c["변환"]
        mark = "⚠️" if c["플래그"] else "  "
        print(f"{mark} 원본 {c['원본']['행']}행 | {t['받는사람']} | {t['받는분전화번호']} | {t['수량']} | {t['주소']} | {t['보내는사람']}")
        for fl in c["플래그"]:
            print(f"      - {fl}")


def cmd_apply(args):
    with open(args.file, encoding="utf-8") as f:
        data = json.load(f)
    rows = [r for r in data["rows"] if r.get("통과")]
    if not rows:
        print("❌ 통과(합의 90점 이상) 표시된 줄이 없어요. 아무것도 기록하지 않았어요.")
        sys.exit(1)
    if not args.yes:
        print(f"미리보기: {len(rows)}건을 {data['main_tab']} 에 기록하고 {data['queue_tab']} 상태를 '완료'로 바꿉니다. 실제로 하려면 --yes")
        for r in rows:
            t = r["변환"]
            print(f"  • {t['받는사람']} | {t['받는분전화번호']} | {t['수량']} | {t['주소']} | {t['보내는사람']}")
        return

    ss = open_spreadsheet()
    main = ss.worksheet(data["main_tab"])
    queue = ss.worksheet(data["queue_tab"])

    # 원본이 그 사이 바뀌지 않았는지 확인 (확인 시점과 같은 내용·상태일 때만 진행)
    qvals = queue.get_all_values()
    for r in rows:
        n = r["원본"]["행"]
        cur = (qvals[n - 1] + [""] * 13) if n - 1 < len(qvals) else [""] * 13
        same = (cur[C_NAME - 1], cur[C_PHONE - 1], cur[C_ADDR - 1], cur[C_STATUS - 1].strip()) == \
               (r["원본"]["받는사람"], r["원본"]["받는분전화번호"], r["원본"]["주소"], "확인")
        if not same:
            print(f"❌ 중단: 주문접수 {n}행이 준비 이후 바뀌었어요. 처음부터 다시 prepare 하세요. 아무것도 기록하지 않았어요.")
            sys.exit(1)

    peach.backup(main, tag="before-move")
    now = datetime.now()
    out_rows = [[r["변환"]["입력시각"]] + [r["변환"].get(k, "") for k in peach.FIELDS] for r in rows]
    prev = peach.last_record_date(main)
    sep = prev is not None and prev != now.strftime("%Y-%m-%d")
    if sep:
        out_rows.insert(0, [""] * len(peach.HEADERS))
    peach.with_retry(lambda: main.append_rows(out_rows, value_input_option="RAW"))
    if sep:
        print(f"📅 날짜 변경({prev} → {now:%Y-%m-%d}) — 구분용 빈 행 1줄 삽입")

    updates = [{"range": f"I{r['원본']['행']}", "values": [["완료"]]} for r in rows]
    peach.with_retry(lambda: queue.batch_update(updates))
    print(f"✅ {len(rows)}건 {data['main_tab']} 기록, {data['queue_tab']} 상태 '완료' 처리")
    # 되읽기 확인
    tail = peach.data_rows(main)[-len(rows):]
    for r in tail:
        print(f"  • {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[5]}")


def main():
    p = argparse.ArgumentParser(description="주문접수 → 27년주문 이동")
    p.add_argument("--queue-tab", default=QUEUE_TAB)
    p.add_argument("--main-tab", default=MAIN_TAB)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("prepare"); a.add_argument("--out")
    b = sub.add_parser("apply"); b.add_argument("file"); b.add_argument("--yes", action="store_true")
    args = p.parse_args()
    {"prepare": cmd_prepare, "apply": cmd_apply}[args.cmd](args)


if __name__ == "__main__":
    main()
