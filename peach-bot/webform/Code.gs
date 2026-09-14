/**
 * 복숭아 주문 접수 웹앱
 * 보내는사람은 한 번만 입력하고, 받는사람은 원하는 만큼 추가.
 * 제출하면 받는사람 수만큼 여러 줄이 스프레드시트 '주문접수' 탭에 쌓인다.
 * (기록 시트가 아니라 접수 큐 — 검토 후 확정하는 용도)
 */
var SPREADSHEET_ID = '1tuHinCYqBQCNc80MgmppkioqEkwQ4hO5m6UnraB-7tY';
var SHEET_NAME = '주문접수';
var HEADERS = ['접수시각', '받는사람', '받는분전화번호', '수량', '주소',
               '보내는사람', '보내는분전화번호', '비고', '상태'];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Page')
    .setTitle('복숭아 주문 접수')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function submitOrder(data) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
  }
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);

  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  var sName  = (data.senderName  || '').trim();
  var sPhone = (data.senderPhone || '').trim();

  var rows = [];
  (data.recipients || []).forEach(function (r) {
    if (!(r.name || '').trim()) return; // 이름 없는 줄은 건너뜀
    rows.push([now, r.name.trim(), (r.phone || '').trim(), (r.qty || '').trim(),
               (r.addr || '').trim(), sName, sPhone, (r.variety || '').trim(), '접수']);
  });

  if (!rows.length) throw new Error('받는 분을 한 명 이상 입력해주세요.');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  return rows.length;
}
