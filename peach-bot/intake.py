"""접수 — 들어온 주문을 무엇이든 파일로 떨구고, 기계가 볼 수 있는 위험 신호를 먼저 잰다.

주문은 양식 없이 아무렇게나 들어온다. 그걸 통제하는 대신 **받는 쪽을 두껍게** 한다.

이 모듈이 하는 일은 두 가지다.

**1. 모든 입력을 파일로 만든다.**
판독팀(reader/checker/lead)은 Read 만 가진다. 그래서 경로가 없는 입력은 팀에 넘길 수가
없었고, 붙여넣은 텍스트는 늘 단독 판독으로 내려갔다. 카톡 텍스트가 가장 많이 들어오는
경로인데 거기가 교차검증이 가장 얇았다는 뜻이다. 텍스트도 파일로 떨구면 그 구멍이 없어진다.

**2. 위험 신호를 센다 — 판정하지 않는다.**
아래 신호는 "이건 팀에 넘겨라"는 근거이지 판독 결과가 아니다. 최종 판단은 Claude 가
하고, 기록 여부는 사람이 정한다. 여기서 세는 건 기계가 확실히 셀 수 있는 것뿐이다.

사용법:
    python intake.py --text -                 stdin 으로 받은 텍스트를 접수
    python intake.py --text "붙여넣은 내용"
    python intake.py --images                 대화창에 붙여넣은 이미지를 접수
    python intake.py --file <경로>            이미 파일인 것을 접수
    python intake.py --text - --json          결과를 JSON 으로
"""
import os
import sys
import json
import shutil
import argparse
from pathlib import Path
from datetime import datetime

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import re                          # noqa: E402
import parse as parse_mod          # noqa: E402
from kakao import PATTERNS as KAKAO_PATTERNS   # noqa: E402

MASKED_PHONE = re.compile(r"0\d{1,2}\s*[.·*x…]{2,}\s*\d{3,4}")
TOTAL_EXPR = re.compile(r"(총|합계|모두)\s*\d+\s*(박스|개|상자)")

# 위험 신호별 가중치. 합이 클수록 판독팀에 넘길 이유가 크다.
# 숫자 자체에 의미는 없다 — 신호를 한 줄로 요약해 보여주기 위한 것이고,
# 경계에 걸리면 사람에게 묻는 쪽으로 기울도록 잡았다.
WEIGHT = {
    "이미지": 5,             # 사진·캡처는 늘 팀. 글자를 잘못 볼 수 있다
    "카톡원문": 5,           # 잡담과 여러 메시지에 흩어진 주문. 규칙 파서로는 못 읽는다
    "가려진번호": 3,
    "전화자릿수오류": 2,
    "필수값결손": 2,
    "합계표현": 2,           # 총 N박스 — 개별 합과 검산해야 한다
    "다건": 1,               # 한 입력에 여러 건이면 섞일 위험
    "발신자불명": 1,
}
TEAM_THRESHOLD = 3           # 이 이상이면 판독팀 권장


def inbox_dir(base=None):
    d = Path(base) if base else HERE / "inbox" / datetime.now().strftime("%Y%m%d_%H%M%S")
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_text(text, out=None):
    """텍스트를 파일로. 이걸 해야 판독팀에 넘길 수 있다."""
    d = inbox_dir(out)
    path = d / "order_01.txt"
    path.write_text(text, encoding="utf-8")
    return [path]


def save_file(src, out=None):
    d = inbox_dir(out)
    dst = d / Path(src).name
    shutil.copy2(src, dst)
    return [dst]


def save_images(out=None, take_all=False):
    """붙여넣은 이미지는 extract_pasted.py 가 이미 한다. 그걸 그대로 쓴다."""
    import extract_pasted
    transcript = extract_pasted.find_transcript(None)
    if not transcript:
        raise RuntimeError("세션 트랜스크립트를 찾지 못했습니다.")
    sources = extract_pasted.collect(transcript, take_all=take_all)
    if not sources:
        raise RuntimeError("붙여넣은 이미지가 없습니다.")

    import base64, hashlib
    d = inbox_dir(out)
    seen, paths = set(), []
    for src in sources:
        raw = base64.b64decode(src["data"])
        digest = hashlib.md5(raw).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        ext = extract_pasted.EXT.get(src.get("media_type"), "png")
        path = d / f"order_{len(paths) + 1:02d}.{ext}"
        path.write_bytes(raw)
        paths.append(path)
    return paths


def assess(paths):
    """기계가 확실히 셀 수 있는 위험 신호만 센다. 판독도 판정도 하지 않는다."""
    signals, detail = {}, []
    images = [p for p in paths if p.suffix.lower() != ".txt"]
    if images:
        signals["이미지"] = len(images)
        detail.append(f"이미지 {len(images)}장 — 글자를 잘못 볼 수 있어 교차검증이 필요하다")

    texts = [p for p in paths if p.suffix.lower() == ".txt"]
    for p in texts:
        body = p.read_text(encoding="utf-8")

        # 가려진 번호와 합계 표현은 **원문에서 직접** 센다.
        # 파싱 결과에 기대면 파싱이 실패하는 입력에서 신호를 통째로 놓친다 —
        # 정작 그때가 가장 위험한데.
        masked = MASKED_PHONE.findall(body)
        if masked:
            signals["가려진번호"] = len(masked)
            detail.append(f"가려진 번호 {len(masked)}건 {masked[:3]} — 채우면 안 된다")

        if TOTAL_EXPR.search(body):
            signals["합계표현"] = 1
            detail.append("'총 N박스' 표현 — 개별 수량 합과 검산해야 한다")

        # 카톡 원문이면 parse.py 로 읽어봐야 의미가 없다(잡담·여러 메시지에 흩어짐).
        # 거기서 나온 숫자를 근거로 내밀면 허수를 보여주는 셈이라 아예 건너뛴다.
        kakao_lines = sum(1 for line in body.splitlines()
                          if any(pat.match(line) for pat in KAKAO_PATTERNS))
        if kakao_lines >= 2:
            signals["카톡원문"] = kakao_lines
            detail.append(f"카톡 대화 원문으로 보임 ({kakao_lines}줄) — "
                          f"kakao.py 로 먼저 묶은 뒤 판독팀에 넘길 것")
            continue

        r = parse_mod.parse(body)
        orders = r["orders"]

        if len(orders) > 1:
            signals["다건"] = len(orders)
            detail.append(f"한 입력에 {len(orders)}건 — 행이 섞일 수 있다")

        bad = sum(1 for o in orders for n in o.get("_확인필요", []) if "자릿수" in n)
        if bad:
            signals["전화자릿수오류"] = bad
            detail.append(f"전화번호 자릿수 오류 {bad}건")

        missing = sum(1 for o in orders
                      for n in o.get("_확인필요", []) if n.endswith("없음"))
        if missing:
            signals["필수값결손"] = missing
            detail.append(f"빈 필수값 {missing}개 — 원문에 없는 건지 못 읽은 건지 확인 필요")

        if orders and not any((o.get("보내는사람") or "").strip() for o in orders):
            signals["발신자불명"] = 1
            detail.append("보내는사람이 어디에도 없다 — 카톡 발신자 이름으로 채울 수 있는지 확인")

    score = sum(WEIGHT.get(k, 0) for k in signals)
    return {
        "신호": signals,
        "설명": detail,
        "점수": score,
        "권장": "판독팀" if score >= TEAM_THRESHOLD else "단독 판독 가능",
    }


def main():
    ap = argparse.ArgumentParser(description="주문 접수 — 파일로 떨구고 위험 신호를 잰다")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--text", help="주문 텍스트. '-' 이면 stdin")
    g.add_argument("--images", action="store_true", help="붙여넣은 이미지를 접수")
    g.add_argument("--file", help="이미 파일인 것을 접수")
    ap.add_argument("--all", action="store_true", help="--images 일 때 세션 전체 이미지")
    ap.add_argument("--out", help="저장 폴더 지정 (기본 inbox/<날짜시각>)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    try:
        if args.images:
            paths = save_images(args.out, args.all)
        elif args.file:
            if not os.path.isfile(args.file):
                print(f"❌ 파일이 없습니다: {args.file}", file=sys.stderr)
                sys.exit(1)
            paths = save_file(args.file, args.out)
        else:
            text = sys.stdin.buffer.read().decode("utf-8") if args.text == "-" else args.text
            if not text.strip():
                print("❌ 접수할 내용이 비어 있습니다.", file=sys.stderr)
                sys.exit(1)
            paths = save_text(text, args.out)
    except RuntimeError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(2)

    result = assess(paths)
    result["파일"] = [str(p) for p in paths]

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    print(f"📥 접수 {len(paths)}건 — {paths[0].parent}")
    for p in paths:
        print(f"   {p}")
    print()
    if result["설명"]:
        print("위험 신호:")
        for d in result["설명"]:
            print(f"   • {d}")
    else:
        print("위험 신호: 없음")
    print(f"\n권장 경로: {result['권장']}  (점수 {result['점수']}, 기준 {TEAM_THRESHOLD})")
    print("   ※ 이건 근거일 뿐 판정이 아니다. 최종 판단은 Claude 가, 기록 여부는 사람이 정한다.")


if __name__ == "__main__":
    main()
