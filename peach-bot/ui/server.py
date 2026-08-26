"""복숭아 주문 UI 서버.

브라우저 화면(index.html)과 기존 CLI 모듈(peach.py / validate.py / parse.py / export.py)
사이를 잇는 얇은 껍데기다. **업무 로직을 여기서 새로 만들지 않는다** — 기록은
peach.append_orders, 검증은 validate.check_phone, 파싱은 parse.parse 를 그대로 부른다.
CLI 로 하든 화면으로 하든 같은 코드를 지나가야 결과가 갈리지 않는다.

두 가지 모드:
    python ui/server.py            실제 구글시트 (.env 의 서비스계정 필요)
    python ui/server.py --demo     가짜 데이터. 자격증명 없이 화면만 둘러볼 때

안전:
  - 127.0.0.1 에만 바인딩한다. 고객 개인정보라 외부에 열지 않는다.
  - 삭제 기능은 화면에 없다. 마우스로 지워지면 안 되는 데이터라 CLI 로만 남긴다.
  - 실제 시트에 쓰기 전 CSV 백업을 자동으로 남긴다.

웹 프레임워크를 쓰지 않은 이유: 이 화면은 사장님 PC에서 더블클릭으로 떠야 한다.
새로 설치할 의존성을 늘리지 않으려고 표준 라이브러리 http.server 로만 짰다.
"""
import os
import re
import sys
import time
import json
import argparse
import webbrowser
import mimetypes
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # peach-bot/
sys.path.insert(0, ROOT)

import parse as parse_mod             # noqa: E402
import export as export_mod           # noqa: E402
import intake as intake_mod           # noqa: E402
import kakao as kakao_mod             # noqa: E402
import audit as audit_mod             # noqa: E402

HEADERS = export_mod.HEADERS
FIELDS = HEADERS[1:]
CHECK_COLS = ["받는사람", "받는분전화번호", "수량", "주소",
              "보내는사람", "보내는분전화번호"]

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

# validate 는 requests/dotenv 를 끌어온다. 없거나 깨져도 화면은 떠야 하므로
# 실패하면 전화번호 검사만 자체 구현으로 낮춰 쓴다(같은 규칙: 010은 11자리).
try:
    from validate import check_phone, PASS
except Exception as e:                                    # pragma: no cover
    print(f"⚠️ validate.py 를 못 불러왔습니다({e}). 전화번호 검사는 내장 규칙으로 대체합니다.")
    PASS = "PASS"

    class _R:
        def __init__(self, status, reason="", normalized=None):
            self.status, self.reason, self.normalized = status, reason, normalized

    def check_phone(phone):
        if not (phone or "").strip():
            return _R("FAIL", "전화번호 없음")
        d = re.sub(r"\D", "", phone)
        if d.startswith("010"):
            if len(d) != 11:
                return _R("FAIL", f"010 번호는 11자리여야 함 (현재 {len(d)}자리: {d})")
            return _R(PASS, normalized=f"{d[:3]}-{d[3:7]}-{d[7:]}")
        if not 9 <= len(d) <= 11:
            return _R("FAIL", f"전화번호 자리수가 이상함: {d}")
        return _R(PASS, normalized=d)


def logger_warn(msg):
    print(f"⚠️ {msg}", file=sys.stderr)


# ── 시트 백엔드 ─────────────────────────────────────────────
#
# 화면은 아래 세 가지만 요구한다: read / append / update.
# 데모와 실제 시트가 같은 모양을 갖도록 맞춰 두고, 나머지 코드는 어느 쪽인지 모른다.

class DemoBackend:
    """자격증명 없이 화면을 둘러보기 위한 가짜 시트. 메모리에만 있다."""

    mode = "demo"

    def __init__(self):
        t = datetime.now().strftime("%Y-%m-%d")
        y = "2026-08-25"
        self.rows = [
            [f"{y} 09:12:03", "홍길동", "010-2345-6789", "2박스",
             "서울특별시 강남구 테헤란로 152 강남파이낸스센터 15층", "최복숭아", "010-1111-2222", ""],
            [f"{y} 09:12:03", "김철수", "010-3456-789", "1박스",
             "경기도 성남시 분당구 판교로 235", "최복숭아", "010-1111-2222", ""],
            [f"{y} 09:40:11", "이영희", "010-4567-8901", "3박스",
             "부산광역시 해운대구 센텀중앙로 55", "", "", "발송자 확인 필요"],
            ["", "", "", "", "", "", "", ""],
            [f"{t} 10:02:44", "박민수", "010-5678-9012", "2박스",
             "대구광역시 수성구 동대구로 123", "최복숭아", "010-1111-2222", ""],
            [f"{t} 10:02:44", "홍길동", "010-2345-6789", "2박스",
             "서울특별시 강남구 테헤란로 152 강남파이낸스센터 15층", "최복숭아", "010-1111-2222", ""],
            [f"{t} 10:15:00", "정수진", "010-6789-0123", "",
             "", "최복숭아", "010-1111-2222", "주소 손글씨 판독 불가"],
        ]

    def read(self):
        return [list(r) for r in self.rows]

    def append(self, orders, no_separator=False):
        now = datetime.now()
        rows = [[now.strftime("%Y-%m-%d %H:%M:%S")] + [(o.get(k) or "") for k in FIELDS]
                for o in orders]
        prev = next((r[0][:10] for r in reversed(self.rows) if any(r)), None)
        today = now.strftime("%Y-%m-%d")
        sep = prev is not None and prev != today and not no_separator
        if sep:
            self.rows.append([""] * len(HEADERS))
        self.rows.extend(rows)
        return {"rows": rows, "separator": sep, "prev_date": prev, "date": today}

    def update(self, rownum, col, value):
        self.rows[rownum - 2][HEADERS.index(col)] = value

    def backup(self):
        return None


class LiveBackend:
    """실제 구글시트. peach.py 를 그대로 쓴다."""

    mode = "live"

    # 검토 화면에서 칸을 고칠 때마다 시트 전체를 백업하면 파일이 수백 개 쌓이고
    # 매번 전체 읽기가 한 번 더 붙어 느려진다. 기록(append)은 항상 백업하고,
    # 낱개 수정은 이 간격 안에서 한 번만 백업한다.
    UPDATE_BACKUP_INTERVAL = 600      # 초

    def __init__(self):
        import peach
        self.peach = peach
        self.sheet = peach.get_sheet()
        self._last_backup = 0.0
        peach.init_sheet(self.sheet)

    def read(self):
        return self.peach.with_retry(lambda: self.sheet.get_all_values())[1:]

    def append(self, orders, no_separator=False):
        self.backup()                 # 여러 건이 한꺼번에 들어가므로 항상 백업
        return self.peach.append_orders(self.sheet, orders, no_separator)

    def update(self, rownum, col, value):
        self.backup(throttle=True)
        a1 = f"{chr(ord('A') + HEADERS.index(col))}{rownum}"
        self.peach.with_retry(
            lambda: self.sheet.update(a1, [[value]], value_input_option="RAW"))

    def backup(self, throttle=False):
        """쓰기 직전 CSV 백업. 백업이 실패하면 예외가 올라가 쓰기도 중단된다."""
        now = time.monotonic()
        if throttle and (now - self._last_backup) < self.UPDATE_BACKUP_INTERVAL:
            return None
        path, n = self.peach.backup(self.sheet, tag="before-ui-write")
        self._last_backup = now
        print(f"💾 백업 {path} ({n}건)")
        return path


# ── 행 주석 달기 (검토 화면용) ──────────────────────────────

def norm_addr(s):
    return re.sub(r"\s+", "", s or "")


def digits(s):
    return re.sub(r"\D", "", s or "")


def annotate(raw_rows):
    """시트 행에 검토용 표시를 붙인다. 값은 절대 바꾸지 않는다.

    - blanks     : 비어 있어서 배송에 지장 있는 열 이름
    - phone_error: 전화번호 자릿수 문제 (validate 와 같은 규칙)
    - dup        : 중복 의심 묶음 번호. 같은 사람+주소, 또는 같은 전화번호.
    """
    rows = []
    for i, r in enumerate(raw_rows):
        rownum = i + 2                       # 헤더가 1행
        r = export_mod.pad(r)
        if export_mod.is_blank_row(r):
            rows.append({"row": rownum, "cells": r, "separator": True,
                         "blanks": [], "phone_error": None, "dup": None})
            continue
        blanks = [c for c in CHECK_COLS if not r[HEADERS.index(c)].strip()]
        phone = r[HEADERS.index("받는분전화번호")]
        res = check_phone(phone) if phone.strip() else None
        rows.append({
            "row": rownum, "cells": r, "separator": False, "blanks": blanks,
            "phone_error": None if (res is None or res.status == PASS) else res.reason,
            "dup": None,
        })

    # 중복 묶기 — 같은 키를 가진 행이 2건 이상이면 같은 번호를 붙인다.
    groups, gid = {}, 0
    for key_fn in (lambda r: ("주소", r["cells"][1].strip(), norm_addr(r["cells"][4])),
                   lambda r: ("전화", digits(r["cells"][2]))):
        buckets = {}
        for r in rows:
            if r["separator"]:
                continue
            key = key_fn(r)
            if not all(k for k in key[1:]):
                continue
            buckets.setdefault(key, []).append(r)
        for key, members in buckets.items():
            if len(members) < 2:
                continue
            if key in groups:
                continue
            gid += 1
            groups[key] = gid
            for m in members:
                if m["dup"] is None:
                    m["dup"] = gid
    return rows


def dup_hits(backend, orders):
    """기록 전 중복 확인. peach.py search 와 같은 기준(받는사람/주소 부분일치)."""
    existing = [export_mod.pad(r) for r in backend.read()
                if not export_mod.is_blank_row(r)]
    out = []
    for idx, o in enumerate(orders):
        name, addr = (o.get("받는사람") or "").strip(), (o.get("주소") or "").strip()
        hits = []
        for r in existing:
            same_name = name and r[1].strip() == name
            same_addr = addr and norm_addr(r[4]) == norm_addr(addr)
            same_phone = digits(o.get("받는분전화번호")) and \
                digits(r[2]) == digits(o.get("받는분전화번호"))
            if (same_name and same_addr) or (same_name and same_phone):
                hits.append({"date": r[0], "name": r[1], "phone": r[2],
                             "qty": r[3], "addr": r[4]})
        if hits:
            out.append({"index": idx, "hits": hits[:5], "total": len(hits)})
    return out


# ── HTTP ────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    backend = None
    server_version = "peach-ui"

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write(f"  {args[0]}\n")

    # -- 응답 도우미 --
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code, message):
        self._send(code, {"error": message})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    # -- 라우팅 --
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                return self._static("index.html")
            if u.path == "/favicon.ico":
                # 브라우저가 자동으로 찾는다. 없으면 콘솔에 404가 남아 진짜 오류를 가린다.
                return self._send(204, b"", "image/x-icon")
            if u.path == "/api/state":
                return self._send(200, self.state())
            if u.path == "/api/export":
                return self.export(q)
            return self._fail(404, "없는 경로")
        except Exception as e:
            return self._fail(500, f"{type(e).__name__}: {e}")

    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self._body()
            if u.path == "/api/parse":
                return self._send(200, self.parse_text(body))
            if u.path == "/api/add":
                return self._send(200, self.add(body))
            if u.path == "/api/update":
                return self._send(200, self.update(body))
            return self._fail(404, "없는 경로")
        except Exception as e:
            return self._fail(500, f"{type(e).__name__}: {e}")

    def _static(self, name):
        path = os.path.join(HERE, name)
        if not os.path.isfile(path):
            return self._fail(404, f"{name} 없음")
        ctype = mimetypes.guess_type(path)[0] or "text/plain"
        with open(path, "rb") as f:
            self._send(200, f.read(), f"{ctype}; charset=utf-8")

    # -- 기능 --
    def state(self):
        rows = annotate(self.backend.read())
        data = [r["cells"] for r in rows if not r["separator"]]
        dates = sorted({export_mod.row_date(c) for c in data if export_mod.row_date(c)})
        today = datetime.now().strftime("%Y-%m-%d")
        return {
            "mode": self.backend.mode,
            "headers": HEADERS,
            "rows": rows,
            "dates": dates,
            "today": today,
            "stats": {
                "전체": export_mod.summarize(data),
                "오늘": export_mod.summarize([c for c in data
                                              if export_mod.row_date(c) == today]),
            },
            "issues": {
                "빈칸": sum(len(r["blanks"]) for r in rows),
                "전화오류": sum(1 for r in rows if r["phone_error"]),
                "중복의심": len({r["dup"] for r in rows if r["dup"]}),
            },
        }

    def parse_text(self, body):
        text = body.get("text", "")

        # 파싱보다 먼저 평가한다. 파싱 결과를 못 믿는 입력이 있는데,
        # 그걸 모른 채 표를 보여주면 "1건 읽었습니다"가 성공처럼 보인다.
        assess = intake_mod.assess_text(text)

        if assess["차단"]:
            # 카톡 원문이면 묶어서 보여준다. 막기만 하면 사용자가 뭘 해야 할지 모른다.
            groups = []
            if "카톡원문" in assess["신호"]:
                try:
                    groups = kakao_mod.group(kakao_mod.parse_lines(text))
                except Exception as e:
                    logger_warn(f"카톡 묶기 실패: {e}")
            return {"orders": [], "format": "화면에서 다룰 수 없는 입력",
                    "접수": assess, "카톡묶음": groups, "중복": []}

        res = parse_mod.parse(text)
        res["접수"] = assess
        for o in res["orders"]:
            phone = o.get("받는분전화번호", "")
            r = check_phone(phone) if phone.strip() else None
            o["_전화"] = {
                "ok": r is None or r.status == PASS,
                "reason": "" if (r is None or r.status == PASS) else r.reason,
                # 정규화 값은 '제안'으로만 넘긴다. 적용은 화면에서 사람이 누른다.
                "제안": (r.normalized if r and r.status == PASS
                         and r.normalized != phone else ""),
            }
        res["중복"] = dup_hits(self.backend, res["orders"])
        return res

    def add(self, body):
        orders = body.get("orders") or []
        if not orders:
            return {"error": "기록할 주문이 없습니다."}

        # 화면이 막았더라도 서버에서 한 번 더 본다. 화면은 우회될 수 있다.
        text = body.get("원문", "")
        assess = intake_mod.assess_text(text) if text else None
        if assess and assess["차단"]:
            return {"error": f"이 입력({', '.join(assess['차단사유'])})은 화면에서 기록할 수 "
                             f"없습니다. 대화창으로 주시면 판독팀이 읽습니다."}

        clean = [{k: (o.get(k) or "").strip() for k in FIELDS} for o in orders]
        bad = [i for i, o in enumerate(clean, 1) if not o["받는사람"]]
        if bad:
            return {"error": f"{bad}번 행에 '받는사람'이 없습니다. 기록을 중단했습니다."}

        res = self.backend.append(clean, no_separator=bool(body.get("no_separator")))

        # 판독기록 — 화면에서 넣은 건 전부 '단독'이다(판독팀을 안 거쳤으므로).
        # 기록이 실패해도 주문 기록은 이미 끝났으니 되돌리지 않는다. 경고만 남긴다.
        try:
            audit_mod.write({
                "종류": "텍스트",
                "점수": assess["점수"] if assess else 0,
                "신호": sorted(assess["신호"]) if assess else [],
                "경로": "단독",
                "판독": len(clean),
                "불일치": 0,
                "기록": len(res["rows"]),
                "보류": 0,
                "출처": "화면",
            })
        except Exception as e:
            logger_warn(f"판독기록 실패(주문 기록은 완료됨): {e}")

        return {"ok": True, "added": len(res["rows"]), "separator": res["separator"],
                "prev_date": res["prev_date"], "date": res["date"]}

    def update(self, body):
        rownum, col = int(body.get("row", 0)), body.get("col")
        if col not in HEADERS or col == "입력시각":
            return {"error": f"수정할 수 없는 열입니다: {col}"}
        if rownum < 2:
            return {"error": "행 번호가 잘못되었습니다."}
        self.backend.update(rownum, col, (body.get("value") or "").strip())
        return {"ok": True}

    def export(self, q):
        start = (q.get("start") or [None])[0] or None
        end = (q.get("end") or [None])[0] or None
        fmt = (q.get("format") or ["xlsx"])[0]
        force = (q.get("force") or ["0"])[0] == "1"

        numbered = export_mod.filter_numbered(
            export_mod.number_rows(self.backend.read()), start, end)
        if not numbered:
            return self._fail(400, "선택한 기간에 내보낼 주문이 없습니다.")
        rows = [r for _, r in numbered]

        # 택배사에 넘어가면 되돌릴 수 없다. 여기가 마지막 관문이라 두 가지를 막는다:
        # 빈 칸(배송이 안 나감)과 전화번호 자릿수 오류(연락이 안 돼 반송됨).
        gaps = export_mod.blocking_gaps(numbered)
        for rownum, r in numbered:
            phone = r[HEADERS.index("받는분전화번호")]
            if not phone.strip():
                continue                      # 빈 칸은 위에서 이미 잡았다
            res = check_phone(phone)
            if res.status != PASS:
                gaps.append({"row": rownum, "col": "받는분전화번호",
                             "name": r[1], "reason": res.reason})
        gaps.sort(key=lambda g: g["row"])
        if gaps and not force:
            return self._fail(409, json.dumps({"gaps": gaps}, ensure_ascii=False))

        label = start if start == end else f"{start or '처음'}_{end or '끝'}"
        name = f"복숭아출고_{label}.{fmt}"
        if fmt == "csv":
            data, ctype = export_mod.to_csv(rows), "text/csv"
        else:
            data = export_mod.to_xlsx(rows)
            ctype = ("application/vnd.openxmlformats-officedocument"
                     ".spreadsheetml.sheet")
        self._send(200, data, ctype,
                   {"Content-Disposition":
                    f"attachment; filename*=UTF-8''{quote(name)}"})


def main():
    ap = argparse.ArgumentParser(description="복숭아 주문 UI 서버")
    ap.add_argument("--demo", action="store_true",
                    help="가짜 데이터로 실행 (구글 자격증명 없이 화면만 보기)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if args.demo:
        Handler.backend = DemoBackend()
        print("🍑 데모 모드 — 가짜 데이터입니다. 실제 시트는 건드리지 않습니다.")
    else:
        try:
            Handler.backend = LiveBackend()
        except Exception as e:
            print(f"❌ 구글시트에 연결하지 못했습니다: {type(e).__name__}: {e}")
            print("   .env 의 SPREADSHEET_ID / GOOGLE_CREDENTIALS_FILE 을 확인하세요.")
            print("   화면만 둘러보려면: python ui/server.py --demo")
            sys.exit(1)
        print("🍑 실제 구글시트에 연결되었습니다.")

    url = f"http://127.0.0.1:{args.port}/"
    print(f"   {url}  (끄려면 Ctrl+C)")
    if not args.no_browser:
        webbrowser.open(url)
    # 127.0.0.1 고정 — 고객 개인정보라 같은 네트워크에도 열지 않는다.
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
