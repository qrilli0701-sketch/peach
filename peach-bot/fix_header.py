"""시트 헤더를 bot_v2.py 스키마에 맞춘다. 1행만 덮어쓰고 데이터는 건드리지 않는다.

기존 열이 새 헤더의 앞부분과 순서까지 일치할 때만 진행하고, 아니면 중단한다.
"""
import os
import sys
import time

import gspread
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv()

HEADERS = ["입력시각", "받는사람", "받는분전화번호", "수량", "주소",
           "보내는사람", "보내는분전화번호", "비고", "입력자"]


def with_retry(fn, attempts=5, base=2.0):
    for i in range(attempts):
        try:
            return fn()
        except gspread.exceptions.APIError as e:
            code = e.response.status_code if e.response is not None else 0
            if code not in (429, 500, 502, 503, 504) or i == attempts - 1:
                raise
            wait = base * (2 ** i)
            print(f"  {code} 발생 — {wait:.0f}초 후 재시도 ({i + 1}/{attempts - 1})")
            time.sleep(wait)


creds = Credentials.from_service_account_file(
    os.getenv("GOOGLE_CREDENTIALS_FILE"),
    scopes=["https://www.googleapis.com/auth/spreadsheets"],
)
sheet = with_retry(
    lambda: gspread.authorize(creds).open_by_key(os.getenv("SPREADSHEET_ID")).sheet1
)

before = with_retry(lambda: sheet.row_values(1))
print(f"현재 헤더: {before}")

if before == HEADERS:
    print("이미 일치 — 변경할 것 없음")
    raise SystemExit(0)

# 안전장치: 2번째 열부터 새 헤더와 순서가 같아야만 1행 덮어쓰기를 허용한다.
# (1번째 열은 '날짜' → '입력시각' 이름 변경이라 비교에서 제외)
if before[1:] != HEADERS[1:len(before)]:
    print("\n[중단] 열 구조가 예상과 다릅니다. 자동 변환하지 않습니다.")
    print(f"  기대: {HEADERS[1:len(before)]}")
    print(f"  실제: {before[1:]}")
    raise SystemExit(1)

rows_before = len(with_retry(lambda: sheet.get_all_values()))
with_retry(lambda: sheet.update(values=[HEADERS], range_name="A1:I1"))

after = with_retry(lambda: sheet.row_values(1))
rows_after = len(with_retry(lambda: sheet.get_all_values()))

print(f"변경 헤더: {after}")
print(f"행 수: {rows_before} → {rows_after}")
print("\n결과:", "성공" if after == HEADERS and rows_before == rows_after else "확인 필요")
