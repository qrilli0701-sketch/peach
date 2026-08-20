"""주문 검증 레이어.

판독된 주문(name, phone, address)을 구글시트에 기록하기 직전 3종 검사한다.
자동 교정은 절대 하지 않는다 — API가 찾아준 주소는 사람이 확인할 '제안'으로만 붙인다.

검사:
  1. 전화번호 — 010 은 반드시 11자리. 정규화(010-1234-5678)해서 반환.
  2. 도로명주소 — juso.go.kr 검색 API 로 실존 여부 확인(차단/불통이면 건너뜀).

판정: 막는 검사가 하나도 없으면 RECORD, 하나라도 실패면 HOLD.
(시/도 화이트리스트 검사는 도 생략 표기를 자꾸 헛걸러 실전에서 뺐다. check_sido
 함수는 남겨두되 판정에는 쓰지 않는다.)
"""
import os
import re
import logging

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

logger = logging.getLogger(__name__)

JUSO_CONFM_KEY = os.getenv("JUSO_CONFM_KEY") or "TESTJUSOGOKR"
JUSO_API_URL = "https://www.juso.go.kr/addrlink/addrLinkApi.do"

# PASS: 통과 / FAIL: 오독 확정(HOLD) / NEEDS_CHECK: 사람 확인 필요(HOLD)
# SKIPPED: 검증 불가 — API 차단·불통 등으로 검사 자체를 못 함(오독은 아님).
#          이 경우 주소검사는 건너뛰되 '미검증' 꼬리표를 남기고 기록은 허용한다.
PASS, FAIL, NEEDS_CHECK, SKIPPED = "PASS", "FAIL", "NEEDS_CHECK", "SKIPPED"

SIDO_STANDARD = [
    "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시",
    "대전광역시", "울산광역시", "세종특별자치시", "경기도", "강원특별자치도",
    "충청북도", "충청남도", "전북특별자치도", "전라남도", "경상북도",
    "경상남도", "제주특별자치도",
]

# 실제 주문서에서 자주 쓰이는 줄임말 -> 표준 시도명
SIDO_ALIASES = {
    "서울": "서울특별시", "서울시": "서울특별시", "서울특별시": "서울특별시",
    "부산": "부산광역시", "부산시": "부산광역시", "부산광역시": "부산광역시",
    "대구": "대구광역시", "대구시": "대구광역시", "대구광역시": "대구광역시",
    "인천": "인천광역시", "인천시": "인천광역시", "인천광역시": "인천광역시",
    "광주광역시": "광주광역시",
    "대전": "대전광역시", "대전시": "대전광역시", "대전광역시": "대전광역시",
    "울산": "울산광역시", "울산시": "울산광역시", "울산광역시": "울산광역시",
    "세종": "세종특별자치시", "세종시": "세종특별자치시", "세종특별자치시": "세종특별자치시",
    "경기": "경기도", "경기도": "경기도",
    "강원": "강원특별자치도", "강원도": "강원특별자치도", "강원특별자치도": "강원특별자치도",
    "충북": "충청북도", "충청북도": "충청북도",
    "충남": "충청남도", "충청남도": "충청남도",
    "전북": "전북특별자치도", "전라북도": "전북특별자치도", "전북특별자치도": "전북특별자치도",
    "전남": "전라남도", "전라남도": "전라남도",
    "경북": "경상북도", "경상북도": "경상북도",
    "경남": "경상남도", "경상남도": "경상남도",
    "제주": "제주특별자치도", "제주도": "제주특별자치도", "제주특별자치도": "제주특별자치도",
}

# '광주' 단독 표기는 광주광역시 / 경기 광주시 둘 다 가능해서 확인 필요
AMBIGUOUS_TOKENS = {"광주"}


class CheckResult:
    """개별 검사 1건의 결과."""

    def __init__(self, status, reason="", normalized=None, suggestion=None):
        self.status = status          # PASS / FAIL / NEEDS_CHECK
        self.reason = reason          # 실패/보류 사유
        self.normalized = normalized  # 정규화된 값 (전화번호 등)
        self.suggestion = suggestion  # 사람 확인용 제안 (자동 적용 안 함)

    def __repr__(self):
        return f"CheckResult({self.status}, {self.reason!r})"


# ── 1. 전화번호 ──────────────────────────────────────────────

def check_phone(phone):
    """010 번호는 반드시 11자리(하이픈 제외). 정규화해서 반환."""
    if not phone or not phone.strip():
        return CheckResult(FAIL, "전화번호 없음")

    digits = re.sub(r"\D", "", phone)

    if digits.startswith("010"):
        if len(digits) != 11:
            return CheckResult(
                FAIL, f"010 번호는 11자리여야 함 (현재 {len(digits)}자리: {digits})")
        normalized = f"{digits[0:3]}-{digits[3:7]}-{digits[7:11]}"
        return CheckResult(PASS, normalized=normalized)

    # 010 이 아닌 번호(지역번호, 070 등)는 형식만 느슨하게 검사
    if len(digits) < 9 or len(digits) > 11:
        return CheckResult(FAIL, f"전화번호 자리수가 이상함: {digits}")
    return CheckResult(PASS, normalized=digits)


# ── 2. 시/도 ─────────────────────────────────────────────────

def check_sido(address):
    """주소 맨 앞 토큰을 17개 표준 시도명과 대조."""
    if not address or not address.strip():
        return CheckResult(FAIL, "주소 없음")

    first_token = address.strip().split()[0]

    if first_token in AMBIGUOUS_TOKENS:
        return CheckResult(
            NEEDS_CHECK,
            f"'{first_token}' 단독 표기는 광주광역시/경기 광주시 중 모호함")

    normalized = SIDO_ALIASES.get(first_token)
    if normalized:
        return CheckResult(PASS, normalized=normalized)

    return CheckResult(
        FAIL, f"'{first_token}'은(는) 표준 시도명이 아님(오타 또는 존재하지 않는 지명)")


# ── 3. 도로명주소 (juso.go.kr) ──────────────────────────────

def _juso_query(keyword, timeout=8):
    """juso.go.kr addrLinkApi.do 1회 호출. (totalCount:int, results:list, error:str|None) 반환."""
    params = {
        "confmKey": JUSO_CONFM_KEY,
        "currentPage": 1,
        "countPerPage": 5,
        "keyword": keyword,
        "resultType": "json",
    }
    try:
        resp = requests.get(JUSO_API_URL, params=params, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return 0, [], f"juso API 호출 실패: {e}"
    except ValueError as e:
        return 0, [], f"juso API 응답 파싱 실패: {e}"

    common = data.get("results", {}).get("common", {})
    err_code = common.get("errorCode")
    if err_code and err_code != "0":
        return 0, [], f"juso API 오류({err_code}): {common.get('errorMessage')}"

    total = int(common.get("totalCount", 0) or 0)
    juso_list = data.get("results", {}).get("juso") or []
    return total, juso_list, None


def _strip_detail(address):
    """건물명/동/호/층 등 상세 정보를 떼어내 도로명+번지만 남긴다."""
    addr = address.strip()
    addr = re.sub(r"\([^)]*\)", "", addr)          # 괄호 안 건물명 제거
    addr = addr.split(",")[0]                        # 콤마 뒤 상세주소 제거
    addr = re.sub(r"\s*지하\s*\d*\s*층.*$", "", addr)
    addr = re.sub(r"\s*\d+\s*층.*$", "", addr)
    addr = re.sub(r"\s*[\wㄱ-힣]*\s*\d+동\s*\d*호?.*$", "", addr)
    addr = re.sub(r"\s*\d+호\s*$", "", addr)
    return addr.strip()


def check_road_address(address, parsed_sido=None):
    """juso.go.kr 로 도로명주소 실존 여부를 확인.

    0건이면 건물/동호수를 떼고 한 번 더 시도.
    그래도 0건이면 FAIL('실존하지 않는 주소 = 오독').
    API 결과 시도와 읽은 시도가 다르면 NEEDS_CHECK(불일치 경고).
    """
    if not address or not address.strip():
        return CheckResult(FAIL, "주소 없음")

    total, results, error = _juso_query(address.strip())
    if error:
        # 검증 자체를 못 한 것(차단/불통) — 오독 확정과 구분해 SKIPPED 로 둔다.
        return CheckResult(SKIPPED, f"주소 API 검증 불가(건너뜀): {error}")

    tried_simplified = False
    if total == 0:
        simplified = _strip_detail(address)
        if simplified and simplified != address.strip():
            tried_simplified = True
            total, results, error = _juso_query(simplified)
            if error:
                return CheckResult(SKIPPED, f"주소 API 검증 불가(건너뜀): {error}")

    if total == 0:
        return CheckResult(
            FAIL,
            "juso.go.kr 검색 결과 0건 — 실존하지 않는 주소(오독 가능성)"
            + (" (건물/동호수 제외 후 재시도도 실패)" if tried_simplified else ""))

    top = results[0]
    api_sido = top.get("siNm", "")
    suggestion = top.get("roadAddr") or top.get("jibunAddr")

    if parsed_sido and api_sido and parsed_sido not in api_sido and api_sido not in parsed_sido:
        return CheckResult(
            NEEDS_CHECK,
            f"주소에서 읽은 시도({parsed_sido})와 juso 검색 결과 시도({api_sido})가 다름",
            suggestion=suggestion)

    return CheckResult(PASS, suggestion=suggestion)


# ── 종합 판정 ────────────────────────────────────────────────

def validate_order(order):
    """order: {"name":..., "phone":..., "address":...} (부가 필드는 그대로 통과)

    반환: {
        "verdict": "RECORD" | "HOLD",
        "checks": {"phone": CheckResult, "sido": CheckResult, "road_address": CheckResult},
        "normalized_phone": str|None,
        "suggestion": str|None,   # 사람 확인용, 자동 적용 안 함
        "reasons": [str, ...],    # HOLD 사유 목록
        "notes": [str, ...],      # 기록은 하되 남길 꼬리표(현재는 안 씀, 호환용 빈 리스트)
    }

    판정 규칙:
      - 전화번호가 FAIL 이면 HOLD, 통과하면 RECORD. 주소·시도는 사람이 본다.
    """
    # 검증은 전화번호 하나만 자동으로 건다. 사람이 긴 목록을 훑을 때 놓치기 쉬운
    # '자릿수 빠진 번호'를 기계가 받쳐주는 용도. 주소·시도는 사람 눈으로 본다.
    # (check_road_address / check_sido 함수는 남겨두되 판정에는 쓰지 않는다 —
    #  juso API 가 열리는 환경에서 되살리고 싶으면 여기서 다시 호출하면 된다.)
    phone_r = check_phone(order.get("phone", ""))

    checks = {"phone": phone_r}

    reasons = [f"{k}: {v.reason}" for k, v in checks.items()
               if v.status not in (PASS, SKIPPED) and v.reason]

    verdict = "RECORD" if not reasons else "HOLD"

    return {
        "verdict": verdict,
        "checks": checks,
        "normalized_phone": phone_r.normalized,
        "suggestion": None,
        "reasons": reasons,
        "notes": [],
    }
