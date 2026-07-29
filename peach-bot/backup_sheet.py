"""스프레드시트를 로컬 CSV로 백업 — 읽기 전용.

Google Sheets API가 간헐적으로 503을 뱉으므로 지수 백오프로 재시도한다.
"""
import csv
import os
import sys
import time
from datetime import datetime

import gspread
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv()


def with_retry(fn, attempts=5, base=2.0):
    """503/429 같은 일시적 오류에 대해 지수 백오프 재시도."""
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
print(f"시트 열기 완료: {sheet.spreadsheet.title} / {sheet.title}")

rows = with_retry(lambda: sheet.get_all_values())

os.makedirs("backups", exist_ok=True)
path = os.path.join("backups", f"sheet_{datetime.now():%Y%m%d_%H%M%S}.csv")
with open(path, "w", newline="", encoding="utf-8-sig") as f:
    csv.writer(f).writerows(rows)

print(f"백업 완료: {path}")
print(f"  헤더: {rows[0] if rows else '(없음)'}")
print(f"  데이터: {max(len(rows) - 1, 0)}건")
