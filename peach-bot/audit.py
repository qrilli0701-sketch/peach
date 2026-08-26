"""판독기록 — 무엇을 어떻게 검증했는지 남기고 집계한다.

검수율을 **높이는 것**과 **재는 것**은 다르다. 접수를 통일해 텍스트도 판독팀을
타게 만든 건 커버리지를 올린 것이고, 그게 실제로 뭘 잡아내는지는 세어봐야 안다.

이 기록으로 답하려는 질문은 셋이다.

1. **얼마나 검증했나** — 전체 중 판독팀을 태운 비율
2. **팀이 실제로 뭘 잡았나** — 교차검증에서 불일치가 나온 비율.
   이게 0에 가까우면 팀을 도는 값어치가 없다는 뜻이고, 너무 높으면 판독이 불안하다는 뜻이다
3. **위험 점수 임계값이 맞나** — 단독으로 보낸 건에서 나중에 문제가 나왔다면 기준이 낮은 것이다

**개인정보는 기록하지 않는다.** 이름·전화·주소는 한 글자도 남기지 않고 개수만 센다.
로그가 유출돼도 고객 정보가 새지 않아야 한다. `logs/` 는 gitignore 대상이다.

사용법:
    python audit.py log --종류 텍스트 --점수 6 --경로 팀 --판독 5 \\
        --불일치 2 --기록 4 --보류 1 --신호 가려진번호,합계표현
    python audit.py report            최근 30일
    python audit.py report --days 7
    python audit.py report --json
"""
import os
import sys
import json
import argparse
from pathlib import Path
from datetime import datetime, timedelta

HERE = Path(__file__).resolve().parent
LOG_DIR = HERE / "logs"
LOG_FILE = LOG_DIR / "판독기록.jsonl"

# 개인정보가 실수로 들어오는 걸 막는다. 값이 아니라 개수만 남기는 게 이 로그의 전제다.
PERSONAL = ("받는사람", "주소", "전화", "이름", "phone", "address", "name")


def write(record):
    """기록 한 줄 추가. 개인정보로 보이는 키가 있으면 거부한다."""
    bad = [k for k in record if any(p in k for p in PERSONAL)]
    if bad:
        raise ValueError(f"개인정보로 보이는 항목은 기록하지 않는다: {bad}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    record = {"시각": datetime.now().isoformat(timespec="seconds"), **record}
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def read(days=None):
    if not LOG_FILE.exists():
        return []
    cutoff = (datetime.now() - timedelta(days=days)).isoformat() if days else None
    out = []
    for line in LOG_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue                      # 깨진 줄은 건너뛴다. 집계를 멈출 이유는 아니다
        if cutoff and r.get("시각", "") < cutoff:
            continue
        out.append(r)
    return out


def summarize(records):
    n = len(records)
    if not n:
        return None

    team = [r for r in records if r.get("경로") == "팀"]
    solo = [r for r in records if r.get("경로") == "단독"]
    orders = sum(r.get("판독", 0) for r in records)
    recorded = sum(r.get("기록", 0) for r in records)
    held = sum(r.get("보류", 0) for r in records)

    # 팀을 태운 건 중 실제로 불일치가 나온 비율. 팀의 값어치를 재는 숫자다.
    caught = [r for r in team if r.get("불일치", 0) > 0]

    # 신호별로 몇 번 나왔고 그때 불일치가 몇 번 있었는지 — 임계값 조정 근거
    by_signal = {}
    for r in records:
        for s in r.get("신호", []):
            d = by_signal.setdefault(s, {"횟수": 0, "불일치": 0})
            d["횟수"] += 1
            if r.get("불일치", 0) > 0:
                d["불일치"] += 1

    return {
        "접수": n,
        "주문건수": orders,
        "팀": len(team),
        "단독": len(solo),
        "검수율": len(team) / n if n else 0.0,
        "불일치발견": len(caught),
        "불일치발견율": len(caught) / len(team) if team else None,
        "기록": recorded,
        "보류": held,
        "보류율": held / orders if orders else None,
        "신호별": by_signal,
        "단독_점수분포": sorted(r.get("점수", 0) for r in solo),
        "팀_점수분포": sorted(r.get("점수", 0) for r in team),
    }


def pct(x):
    return "—" if x is None else f"{x * 100:.0f}%"


def render(s, days):
    if not s:
        return f"기록이 없습니다. ({LOG_FILE})"
    L = [f"판독기록 — 최근 {days}일" if days else "판독기록 — 전체", ""]
    L.append(f"  접수 {s['접수']}회 · 주문 {s['주문건수']}건")
    L.append(f"  기록 {s['기록']}건 · 보류 {s['보류']}건 (보류율 {pct(s['보류율'])})")
    L.append("")
    L.append(f"  검수율      {pct(s['검수율'])}   (판독팀 {s['팀']}회 / 단독 {s['단독']}회)")
    L.append(f"  불일치 발견 {pct(s['불일치발견율'])}   (팀을 돈 {s['팀']}회 중 {s['불일치발견']}회)")

    if s["불일치발견율"] is not None:
        if s["불일치발견율"] == 0 and s["팀"] >= 10:
            L.append("     └ 팀이 아무것도 못 잡고 있다. 임계값을 올려 단독을 늘려도 될지 검토")
        elif s["불일치발견율"] and s["불일치발견율"] > 0.3:
            L.append("     └ 불일치가 잦다. 판독이 불안정하거나 원본 품질이 나쁘다")

    if s["신호별"]:
        L.append("")
        L.append("  신호별 — 이 신호가 떴을 때 실제로 불일치가 나온 비율")
        for name, d in sorted(s["신호별"].items(), key=lambda x: -x[1]["횟수"]):
            rate = d["불일치"] / d["횟수"] if d["횟수"] else 0
            L.append(f"    {name:<12} {d['횟수']:>3}회 중 {d['불일치']:>3}회 ({pct(rate)})")
        L.append("     └ 비율이 낮은 신호는 가중치를 낮추고, 높은 신호는 올린다")

    if s["단독_점수분포"]:
        L.append("")
        L.append(f"  단독으로 보낸 건의 위험 점수: {s['단독_점수분포']}")
        L.append("     └ 여기서 나중에 문제가 나왔다면 임계값이 낮은 것이다")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description="판독기록 — 기록과 집계")
    sub = ap.add_subparsers(dest="cmd", required=True)

    lg = sub.add_parser("log", help="접수 1회를 기록")
    lg.add_argument("--종류", required=True, choices=["텍스트", "이미지", "카톡"],
                    dest="kind")
    lg.add_argument("--점수", type=int, default=0, dest="score", help="intake 위험 점수")
    lg.add_argument("--신호", default="", dest="signals", help="쉼표로 구분")
    lg.add_argument("--경로", required=True, choices=["팀", "단독"], dest="route")
    lg.add_argument("--판독", type=int, default=0, dest="read", help="판독한 주문 건수")
    lg.add_argument("--불일치", type=int, default=0, dest="mismatch",
                    help="교차검증에서 나온 불일치 항목 수")
    lg.add_argument("--건수일치", default="", dest="count_ok",
                    choices=["", "예", "아니오"], help="reader/checker 건수 일치 여부")
    lg.add_argument("--기록", type=int, default=0, dest="recorded")
    lg.add_argument("--보류", type=int, default=0, dest="held")
    lg.add_argument("--접수경로", default="", dest="inbox", help="inbox 폴더명 (파일명만)")

    rp = sub.add_parser("report", help="집계")
    rp.add_argument("--days", type=int, default=30)
    rp.add_argument("--json", action="store_true")

    args = ap.parse_args()
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    if args.cmd == "log":
        rec = {
            "종류": args.kind,
            "점수": args.score,
            "신호": [x for x in args.signals.split(",") if x.strip()],
            "경로": args.route,
            "판독": args.read,
            "불일치": args.mismatch,
            "기록": args.recorded,
            "보류": args.held,
        }
        if args.count_ok:
            rec["건수일치"] = args.count_ok == "예"
        if args.inbox:
            rec["접수경로"] = os.path.basename(args.inbox.rstrip("/\\"))
        write(rec)
        print(f"📝 기록했습니다 — {LOG_FILE}")
        if args.route == "단독" and args.score >= 3:
            print(f"⚠️ 위험 점수 {args.score}인데 단독으로 갔습니다. 의도한 것인지 확인하세요.")
        return

    days = None if args.days <= 0 else args.days
    s = summarize(read(days))
    print(json.dumps(s, ensure_ascii=False, indent=2) if args.json else render(s, days))


if __name__ == "__main__":
    main()
