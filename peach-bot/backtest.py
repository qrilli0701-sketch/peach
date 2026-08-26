"""회귀 코퍼스 — 지금까지 실제로 터진 사고를 실행 가능한 검사로 굳힌 것.

실주문 데이터는 개인정보라 저장소에 없다. 대신 **문서와 커밋 메시지에 남은
실제 사고와 실제 값 형태**를 사례로 옮겼다. 각 사례에 출처를 달아 두었으니
"왜 이 검사가 있는지"를 나중에도 추적할 수 있다.

이건 515건 백테스트가 아니다. 그건 시트가 붙은 환경에서 따로 해야 한다.
여기서 보장하는 건 **한 번 당한 사고를 다시 당하지 않는 것**이다.

    python backtest.py           전부 실행
    python backtest.py -v        통과한 것도 자세히
"""
import sys
import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import parse as P                     # noqa: E402
import export as E                    # noqa: E402
import kakao as K                     # noqa: E402
import intake as I                    # noqa: E402
from validate import check_phone, PASS  # noqa: E402


def one(text):
    """텍스트를 파싱해 첫 건을 돌려준다. 없으면 빈 dict."""
    r = P.parse(text)
    return r["orders"][0] if r["orders"] else {}


def orders(text):
    return P.parse(text)["orders"]


# ── 사례 ─────────────────────────────────────────────────────
#
# 각 사례: (분류, 이름, 출처, 검사함수)
# 검사함수는 (통과여부, 설명) 을 돌려준다.

CASES = []


def case(group, name, source):
    def deco(fn):
        CASES.append((group, name, source, fn))
        return fn
    return deco


# ── A. 판독 — 실제 주문서에 나오던 표기들 ──────────────────

@case("판독", "언더스코어 전화번호", "SKILL.md 정규화 규칙 2 — 010_3273_1229 실사례")
def _():
    o = one("이정희 / 010_3273_1229 / 2박스 / 서울 강남구 테헤란로 152")
    got = o.get("받는분전화번호", "")
    return ("3273" in got,
            f"전화 칸={got!r} 비고={o.get('비고','')!r} — 전화 칸에 들어가야 한다")


@case("판독", "동호수를 전화로 오인하지 않음", "SKILL.md — 107-1405 표기 원문 유지")
def _():
    o = one("최민수 / 010-5678-9012 / 3박스 / 경기 성남시 분당구 판교로 235 107-1405")
    return ("107-1405" in o.get("주소", "") and o.get("받는분전화번호") == "010-5678-9012",
            f"주소={o.get('주소','')!r} 전화={o.get('받는분전화번호','')!r}")


@case("판독", "직함은 이름의 일부로 유지", "SKILL.md 정규화 규칙 1 — 본부장/팀장 등")
def _():
    o = one("받는분: 최민수 본부장\n연락처: 010-5678-9012\n주소: 서울 중구 세종대로 1\n수량: 1박스")
    return ("본부장" in o.get("받는사람", ""), f"받는사람={o.get('받는사람','')!r}")


@case("판독", "마스킹 번호는 절대 채우지 않음", "SKILL.md 판독규칙 — 010...1234 는 빈 값")
def _():
    o = one("가려진분 / 010...9999 / 1박스 / 인천 남동구 예술로 100")
    flagged = any("가려" in n for n in o.get("_확인필요", []))
    return (not o.get("받는분전화번호") and flagged,
            f"전화={o.get('받는분전화번호','')!r} 표시={o.get('_확인필요')}")


@case("판독", "5kg 1박스 같은 수량 표기 보존", "SKILL.md 4단계 예시 JSON")
def _():
    o = one("홍길동 / 010-1111-2222 / 5kg 1박스 / 서울 중구 세종대로 1")
    return (o.get("수량") == "5kg 1박스", f"수량={o.get('수량','')!r}")


@case("판독", "품종·착불은 비고에 원문 그대로", "SKILL.md 정규화 규칙 4 — 천중도/황도/착불")
def _():
    o = one("받는분: 홍길동\n연락처: 010-1111-2222\n주소: 서울 중구 세종대로 1\n"
            "수량: 2박스\n요청사항: 천중도로 착불 부탁드려요")
    return ("천중도" in o.get("비고", "") and "착불" in o.get("비고", ""),
            f"비고={o.get('비고','')!r}")


@case("판독", "섞인 형식에서 주문이 사라지지 않음", "2026-08-26 — 형식 통째 선택이 한쪽을 삼킴")
def _():
    got = orders("홍길동 / 010-2345-6789 / 2박스 / 서울 강남구 테헤란로 152\n"
                 "신규객 / 010-3333-4444 / 1박스 / 광주 서구 상무대로 900\n"
                 "받는분: 오미자\n연락처: 010-8888-9999\n수량: 4박스\n주소: 강원 춘천시 중앙로 1")
    return (len(got) == 3, f"{len(got)}건 (3건이어야)")


@case("판독", "줄바꿈된 주소는 이어붙임", "실제 주문서에서 주소가 두 줄로 오는 경우")
def _():
    o = one("받는분: 박길동\n연락처: 010-5555-6666\n수량: 2박스\n"
            "주소: 서울특별시 강남구 테헤란로 152\n강남파이낸스센터 15층")
    return ("강남파이낸스센터" in o.get("주소", ""), f"주소={o.get('주소','')!r}")


@case("판독", "자릿수 틀린 번호는 전화 칸에 남아 표시됨", "2026-08-26 — 비고로 숨으면 사람이 못 봄")
def _():
    o = one("신규객 / 010-777-888 / 1박스 / 광주 서구 상무대로 900")
    return (o.get("받는분전화번호") == "010-777-888"
            and any("자릿수" in n for n in o.get("_확인필요", [])),
            f"전화={o.get('받는분전화번호','')!r} 표시={o.get('_확인필요')}")


# ── B. 검증 ─────────────────────────────────────────────────

@case("검증", "010 은 11자리여야 함", "validate.py — 사람이 놓치는 자릿수 누락을 기계가 받침")
def _():
    bad = check_phone("010-3456-789")
    ok = check_phone("010-3456-7890")
    return (bad.status != PASS and ok.status == PASS and ok.normalized == "010-3456-7890",
            f"9자리={bad.status} 10자리={ok.status}/{ok.normalized}")


# ── C. 접수·분류 ────────────────────────────────────────────

def _assess(text, tmp):
    p = Path(tmp); p.mkdir(parents=True, exist_ok=True)
    f = p / "order_01.txt"; f.write_text(text, encoding="utf-8")
    return I.assess([f])


@case("접수", "양식대로 온 주문은 단독 판독 가능", "2026-08-26 방향 — 쉬운 건 팀을 안 돌림")
def _(tmp="/tmp/bt/a"):
    r = _assess("받는분: 이정희\n연락처: 010-3273-1229\n"
                "주소: 서울 강남구 테헤란로 152\n수량: 2박스\n보내는분: 김순자", tmp)
    return (r["권장"] == "단독 판독 가능", f"권장={r['권장']} 점수={r['점수']}")


@case("접수", "카톡 원문은 판독팀으로", "2026-08-26 — 규칙 파서로 못 읽는 입력")
def _(tmp="/tmp/bt/b"):
    r = _assess("2026년 8월 26일 오전 9:14, 김순자 : 이정희 010-3273-1229\n"
                "2026년 8월 26일 오전 9:15, 김순자 : 서울 강남구 테헤란로 152", tmp)
    return (r["권장"] == "판독팀" and "카톡원문" in r["신호"],
            f"권장={r['권장']} 신호={list(r['신호'])}")


@case("접수", "가려진 번호를 원문에서 직접 잡음", "2026-08-26 — 파싱 실패 입력에서 놓치던 신호")
def _(tmp="/tmp/bt/c"):
    r = _assess("2026년 8월 26일 오전 10:02, 이영희 : 부산 해운대구 55 010...4821\n"
                "2026년 8월 26일 오전 10:03, 이영희 : 1박스요", tmp)
    return ("가려진번호" in r["신호"], f"신호={list(r['신호'])}")


@case("접수", "'총 N박스' 합계 표현을 검산 대상으로 표시", "SKILL.md 판독규칙 — 합계 검산")
def _(tmp="/tmp/bt/d"):
    r = _assess("총 4박스요\n받는분: 정수진\n연락처: 010-6789-0123\n"
                "주소: 대전 유성구 대학로 99\n수량: 2박스", tmp)
    return ("합계표현" in r["신호"], f"신호={list(r['신호'])}")


# ── D. 카톡 구조화 ──────────────────────────────────────────

@case("카톡", "보낸사람이 보내는사람 후보로 남음", "2026-08-25 미결 3건 — 손글씨로 못 읽던 값")
def _():
    g = K.group(K.parse_lines(
        "2026년 8월 26일 오전 9:14, 김순자 : 이정희 010-3273-1229\n"
        "2026년 8월 26일 오전 9:15, 김순자 : 서울 강남구 테헤란로 152"))
    return (len(g) == 1 and g[0]["보낸사람"] == "김순자",
            f"{len(g)}묶음 보낸사람={g[0]['보낸사람'] if g else None}")


@case("카톡", "시스템 메시지가 실제 주문을 삼키지 않음", "2026-08-26 — 주소 한 줄이 통째로 사라짐")
def _():
    g = K.group(K.parse_lines(
        "2026. 8. 26. 오전 9:14, 김순자 : 이정희 010-3273-1229\n"
        "2026. 8. 26. 오전 9:14, 김순자 : 서울 강남구 테헤란로 152\n"
        "2026. 8. 26. 오전 9:14, 아무개님이 들어왔습니다."))
    body = "\n".join(g[0]["메시지"]) if g else ""
    return ("테헤란로 152" in body, f"묶음내용={body!r}")


@case("카톡", "사진 있던 자리를 표시", "SKILL.md — 사진 없이 완결된 주문으로 취급 금지")
def _():
    g = K.group(K.parse_lines("[김순자] [오전 9:14] 지난주 그 주소로 2박스요\n"
                              "[김순자] [오전 9:15] 사진"))
    return (g and g[0]["사진"] == 1, f"사진={g[0]['사진'] if g else None}")


# ── E. 기록·출고 방어 ───────────────────────────────────────

@case("기록", "받는사람 빈 행이 있으면 전체 기록 중단", "2026-07-24 — cp949 로 키가 깨져 빈 값 기록")
def _():
    import peach
    return (peach.missing_name_rows([{"받는사람": "A"}, {"주소": "x"}]) == [2],
            "빈 받는사람 행을 잡아야 한다")


@case("출고", "빈 칸이 있으면 택배사 파일로 못 나감", "2026-08-04 — 빈 칸이 눈에 안 띄어 배송 사고")
def _():
    rows = E.number_rows([["2026-08-26 10:00", "정수진", "010-6789-0123", "", "", "", "", ""]])
    gaps = E.blocking_gaps(rows)
    return (any(g["col"] == "주소" for g in gaps) and any(g["col"] == "수량" for g in gaps),
            f"빈칸={[(g['col']) for g in gaps]}")


@case("출고", "박스 수 → 금액 (40,000 + 택배 5,000, 2박스 묶음)", "핸드오프 가격 모델")
def _():
    got = [E.price_of(n) for n in (1, 2, 3, 4)]
    return (got == [45000, 85000, 130000, 170000], f"1~4박스={got}")


# ── F. 구조 — 규칙이 다시 흩어지지 않는지 ──────────────────
#
# 판독 규칙이 여러 파일에 복사돼 있으면 한 곳만 고쳤을 때 조용히 갈라진다.
# 갈라진 규칙으로 검증하면 검증이 아니다. 그래서 구조 자체를 검사한다.

ROOT = HERE.parent
RULES_FILE = ROOT / ".claude/skills/peach/판독규칙.md"
AGENTS = list((ROOT / ".claude/agents").glob("peach-*.md"))
SKILL_FILE = ROOT / ".claude/skills/peach/SKILL.md"

# 규칙 원문에만 나오는 표지. 다른 파일에 있으면 규칙이 복사된 것이다.
RULE_MARKERS = ["귀하", "천중도", "본부장"]


@case("구조", "판독규칙 단일 출처 파일이 있다", "2026-08-26 — 규칙 3중 복제 정리")
def _():
    return (RULES_FILE.is_file(), f"{RULES_FILE}")


@case("구조", "세 에이전트가 모두 규칙 파일을 가리킨다", "규칙을 기억으로 판독하지 않게")
def _():
    missing = [a.name for a in AGENTS
               if "판독규칙.md" not in a.read_text(encoding="utf-8")]
    return (len(AGENTS) == 3 and not missing,
            f"에이전트 {len(AGENTS)}개, 참조 안 하는 것={missing}")


@case("구조", "규칙 원문이 다른 파일에 복사돼 있지 않다", "복제되면 조용히 갈라진다")
def _():
    dupes = []
    for f in AGENTS + [SKILL_FILE]:
        body = f.read_text(encoding="utf-8")
        hit = [m for m in RULE_MARKERS if m in body]
        if hit:
            dupes.append(f"{f.name}{hit}")
    return (not dupes, f"복제 흔적={dupes or '없음'}")


@case("구조", "에이전트가 텍스트 원본을 전제로 쓰여 있다", "2026-08-26 — 텍스트도 판독팀을 탄다")
def _():
    bad = []
    for a in AGENTS:
        body = a.read_text(encoding="utf-8")
        # '이미지' 단독 전제로 남은 지시가 있으면 텍스트 입력에서 어색해진다
        if "원본" not in body:
            bad.append(a.name)
    return (not bad, f"'원본' 표현이 없는 파일={bad or '없음'}")


# ── G. 판독기록 ─────────────────────────────────────────────

@case("기록", "개인정보는 판독기록에 들어가지 않는다", "로그가 새도 고객 정보는 안 새야 한다")
def _():
    import audit
    blocked = []
    for key in ("받는사람", "주소", "받는분전화번호", "name", "phone"):
        try:
            audit.write({key: "x", "경로": "팀"})
        except ValueError:
            blocked.append(key)
    return (len(blocked) == 5, f"차단된 키={blocked} (5개 전부여야)")


@case("기록", "집계가 검수율과 불일치 발견율을 낸다", "검수율은 재야 올릴 수 있다")
def _():
    import audit
    s = audit.summarize([
        {"경로": "단독", "점수": 0, "판독": 2, "불일치": 0, "기록": 2, "보류": 0, "신호": []},
        {"경로": "팀", "점수": 10, "판독": 5, "불일치": 2, "기록": 4, "보류": 1,
         "신호": ["카톡원문"]},
    ])
    return (s["검수율"] == 0.5 and s["불일치발견율"] == 1.0 and s["주문건수"] == 7,
            f"검수율={s['검수율']} 불일치발견율={s['불일치발견율']} 주문={s['주문건수']}")


# ── 실행 ────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="회귀 코퍼스 실행")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    failed, group_now = [], None
    for grp, name, source, fn in CASES:
        if grp != group_now:
            group_now = grp
            print(f"\n── {grp} " + "─" * (56 - len(grp)))
        try:
            ok, msg = fn()
        except Exception as e:
            ok, msg = False, f"예외: {type(e).__name__}: {e}"
        mark = "✓" if ok else "✗"
        print(f" {mark} {name}")
        if not ok:
            failed.append((grp, name, source, msg))
            print(f"     └ {msg}")
            print(f"     └ 출처: {source}")
        elif args.verbose:
            print(f"     └ {msg}")

    total = len(CASES)
    print(f"\n{'─' * 60}")
    print(f"{total - len(failed)}/{total} 통과")
    if failed:
        print(f"\n실패 {len(failed)}건:")
        for grp, name, source, msg in failed:
            print(f"  • [{grp}] {name}")
            print(f"      {msg}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
