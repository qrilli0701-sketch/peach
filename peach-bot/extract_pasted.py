"""대화창에 붙여넣은 이미지를 파일로 꺼낸다.

붙여넣은 이미지는 디스크에 없고 세션 트랜스크립트(.jsonl)에 base64로만 들어있다.
그래서 서브에이전트(peach-reader/checker)가 Read 할 대상이 없어 교차검증이 통째로
빠졌다(2026-07-30 실제 발생 — 12건을 단독 판독으로 기록). 이 스크립트가 그 간극을 메운다.

사용법:
    python extract_pasted.py              # 가장 최근 붙여넣기 묶음만 꺼냄
    python extract_pasted.py --all        # 세션 전체의 이미지를 꺼냄
    python extract_pasted.py --out DIR    # 저장 위치 지정 (기본 ./inbox)
    python extract_pasted.py --session ID # 세션 지정 (기본: 가장 최근)

출력은 절대경로 한 줄에 하나. 그대로 에이전트에 넘기면 된다.
"""
import os
import sys
import json
import base64
import hashlib
import argparse
from pathlib import Path
from datetime import datetime

EXT = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}


def find_transcript(session_id=None):
    """세션 트랜스크립트 경로. 지정이 없으면 현재 폴더에 해당하는 것 중 최신."""
    root = Path.home() / ".claude" / "projects"
    if not root.is_dir():
        return None
    candidates = list(root.glob("*/*.jsonl"))
    if not candidates:
        return None
    if session_id:
        for p in candidates:
            if p.stem == session_id:
                return p
        return None
    # 현재 작업 폴더(또는 그 상위)에 대응하는 프로젝트 디렉터리를 우선한다.
    # 디렉터리명은 경로 구분자를 '-' 로 바꾼 형태다.
    here = Path.cwd().resolve()
    for base in [here] + list(here.parents):
        slug = str(base).replace(os.sep, "-").replace(":", "")
        matched = [p for p in candidates if p.parent.name == slug]
        if matched:
            return max(matched, key=lambda p: p.stat().st_mtime)
    return max(candidates, key=lambda p: p.stat().st_mtime)


def walk_in_order(node, out):
    """dict/list 를 기록된 순서 그대로 훑는다.

    스택(LIFO)으로 훑으면 순서가 뒤집힌다. 이미지 순서가 뒤집히면 어느 장이 어느
    주문인지 사람이 대조할 때 헷갈리므로 재귀로 순서를 지킨다.

    tool_result 안의 이미지는 건너뛴다. 도구가 돌려준 스크린샷 따위지 주문서가 아니다.
    """
    if isinstance(node, dict):
        if node.get("type") == "tool_result":
            return
        if node.get("type") == "image":
            src = node.get("source") or {}
            if src.get("type") == "base64" and src.get("data"):
                out.append(src)
            return
        for v in node.values():
            walk_in_order(v, out)
    elif isinstance(node, list):
        for v in node:
            walk_in_order(v, out)


def collect(transcript, take_all=False):
    """트랜스크립트에서 이미지를 뽑는다. 기본은 마지막 붙여넣기 묶음만."""
    batches = []
    with open(transcript, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            # 사용자가 보낸 것만 본다. 두 가지 형태가 있다:
            #   type="user"       — 턴 시작 때 보낸 메시지
            #   type="attachment" — 내가 작업하는 도중에 끼어든 메시지 (2026-08-04 발견)
            # attachment 를 빠뜨려서 12명짜리 주문서 표를 못 꺼낸 적이 있다. 둘 다 본다.
            if rec.get("type") not in ("user", "attachment"):
                continue
            found = []
            walk_in_order(rec.get("message") or rec, found)
            if found:
                batches.append(found)
    if not batches:
        return []
    return [s for b in batches for s in b] if take_all else batches[-1]


def main():
    ap = argparse.ArgumentParser(description="붙여넣은 주문서 이미지를 파일로 추출")
    ap.add_argument("--all", action="store_true", help="세션 전체 이미지 (기본: 마지막 묶음만)")
    ap.add_argument("--out", default=None, help="저장 폴더 (기본: <스크립트폴더>/inbox/<날짜시각>)")
    ap.add_argument("--session", default=None, help="세션 ID 지정")
    args = ap.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    transcript = find_transcript(args.session)
    if not transcript:
        print("❌ 세션 트랜스크립트를 찾지 못했습니다.", file=sys.stderr)
        print("   ~/.claude/projects/ 아래에 .jsonl 이 있는지 확인하세요.", file=sys.stderr)
        sys.exit(1)

    sources = collect(transcript, take_all=args.all)
    if not sources:
        print("❌ 붙여넣은 이미지가 없습니다.", file=sys.stderr)
        print(f"   (트랜스크립트: {transcript})", file=sys.stderr)
        print("   이미지를 붙여넣은 직후에 실행해야 합니다.", file=sys.stderr)
        sys.exit(2)

    base = Path(args.out) if args.out else (
        Path(__file__).resolve().parent / "inbox" / datetime.now().strftime("%Y%m%d_%H%M%S"))
    base.mkdir(parents=True, exist_ok=True)

    seen, paths = set(), []
    for src in sources:
        raw = base64.b64decode(src["data"])
        digest = hashlib.md5(raw).hexdigest()
        if digest in seen:          # 같은 이미지가 두 번 실린 경우
            continue
        seen.add(digest)
        path = base / f"order_{len(paths) + 1:02d}.{EXT.get(src.get('media_type'), 'png')}"
        path.write_bytes(raw)
        paths.append(path)

    print(f"📷 {len(paths)}장 추출 (원본 순서 유지) — {transcript.name}", file=sys.stderr)
    for p in paths:
        print(p)


if __name__ == "__main__":
    main()
