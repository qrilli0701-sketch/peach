/**
 * 메일로 받은 '대량주문 엑셀'을 자동으로 읽어 '주문접수' 탭에 적재한다.
 * - qrilli0701@gmail.com 로 온, xlsx 첨부가 있는 메일을 주기적으로 확인
 * - 우리 양식(보내는분 = 6행, 받는분 표 = 10행부터)만 인식, 아니면 건너뜀
 * - 처리한 메일에는 라벨을 붙여 중복 처리 방지
 *
 * [설치]
 *  1) 편집기 왼쪽 '서비스(+)' → 'Drive API' 추가 (식별자: Drive)  ← 엑셀→시트 변환용
 *  2) setupTrigger() 를 한 번 실행 → 5분마다 자동 확인되는 트리거 생성 (권한 승인)
 */
var LABEL_DONE = '임가네처리완료';
var GMAIL_QUERY = 'has:attachment filename:xlsx -label:' + LABEL_DONE + ' newer_than:30d';

function setupTrigger() {
  // 중복 생성 방지: 기존 processOrderEmails 트리거 제거 후 재생성
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processOrderEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processOrderEmails').timeBased().everyMinutes(5).create();
  Logger.log('트리거 생성 완료 — 5분마다 메일 확인');
}

function processOrderEmails() {
  var label = GmailApp.getUserLabelByName(LABEL_DONE) || GmailApp.createLabel(LABEL_DONE);
  var threads = GmailApp.search(GMAIL_QUERY, 0, 20);

  threads.forEach(function (thread) {
    var handledAny = false;
    thread.getMessages().forEach(function (msg) {
      msg.getAttachments().forEach(function (att) {
        var name = att.getName() || '';
        if (!/\.xlsx$/i.test(name)) return;
        try {
          var rows = parseTemplate_(att);
          if (rows && rows.length) {
            appendToQueue_(rows, msg);
            handledAny = true;
          }
        } catch (e) {
          Logger.log('처리 실패(' + name + '): ' + e);
        }
      });
    });
    if (handledAny) thread.addLabel(label);
  });
}

/** 첨부 xlsx 를 Google 시트로 변환하고 파일 id 반환 (Drive 고급서비스 v2/v3 모두 지원) */
function xlsxToSheetId_(blob) {
  var meta = { name: 'temp_order_' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' };
  if (Drive.Files && typeof Drive.Files.create === 'function') {      // v3
    return Drive.Files.create(meta, blob).id;
  }
  if (Drive.Files && typeof Drive.Files.insert === 'function') {      // v2
    return Drive.Files.insert({ title: meta.name }, blob, { convert: true }).id;
  }
  throw new Error('Drive Files API(create/insert) 를 사용할 수 없습니다.');
}

/** 삭제 (v2/v3 모두 지원) */
function removeFile_(id) {
  try {
    if (Drive.Files && typeof Drive.Files.remove === 'function') Drive.Files.remove(id);
    else if (Drive.Files && typeof Drive.Files.trash === 'function') Drive.Files.trash(id);
  } catch (e) {}
}

/** 첨부 xlsx → Google 시트로 변환 후, 우리 양식대로 파싱해 행 배열 반환 */
function parseTemplate_(attachment) {
  var ssId = xlsxToSheetId_(attachment.copyBlob());
  try {
    var sh = SpreadsheetApp.openById(ssId).getSheets()[0];
    var v = sh.getDataRange().getValues();
    // 양식 확인: 9행(index 8) B열이 '받는사람' 이어야 우리 양식
    if (!v[8] || String(v[8][1]).indexOf('받는사람') === -1) return [];

    var sName  = v[5] ? String(v[5][1] || '').trim() : '';   // 6행 B: 보내는분 성함
    var sPhone = v[5] ? normPhone_(v[5][3]) : '';             // 6행 D: 보내는분 연락처

    var out = [];
    for (var r = 9; r < v.length; r++) {           // 10행(index 9)부터 받는분
      var name = String(v[r][1] || '').trim();
      var phone = normPhone_(v[r][2]);
      var qty = String(v[r][3] || '').trim();
      var addr = String(v[r][4] || '').trim();
      var note = String(v[r][5] || '').trim();
      if (!name) continue;
      if (name === '김복숭' && phone === '01012345678') continue; // 예시 행 skip
      out.push([name, phone, qty, addr, sName, sPhone, note]);
    }
    return out;
  } finally {
    removeFile_(ssId);   // 임시 시트 삭제
  }
}

/** 파싱한 행들을 '주문접수' 탭에 기록 */
function appendToQueue_(rows, msg) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);          // Code.gs 의 상수 사용
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(HEADERS); }
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);

  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  var from = msg.getFrom();
  var data = rows.map(function (r) {
    // r: [받는사람, 받는전화, 수량, 주소, 보내는사람, 보내는전화, 비고]
    var miss = [];
    if (!r[1]) miss.push('받는분전화');
    if (!r[2] || !/^[0-9]+$/.test(r[2]) || parseInt(r[2], 10) < 1) miss.push('수량');
    if (!r[3]) miss.push('주소');
    if (!r[4]) miss.push('보내는사람');
    if (!r[5]) miss.push('보내는분전화');
    var status = miss.length ? '확인필요' : '접수';
    var bigo = (r[6] ? r[6] + ' ' : '') + '[메일:' + from + ']' +
               (miss.length ? ' [미비:' + miss.join(',') + ']' : '');
    return [now, r[0], r[1], r[2], r[3], r[4], r[5], bigo.trim(), status];
  });
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 3, data.length, 1).setNumberFormat('@');  // 받는분전화번호
  sh.getRange(start, 7, data.length, 1).setNumberFormat('@');  // 보내는분전화번호
  sh.getRange(start, 1, data.length, HEADERS.length).setValues(data);
  // '확인필요' 행은 노란 음영으로 눈에 띄게
  data.forEach(function (row, i) {
    if (row[8] === '확인필요') sh.getRange(start + i, 1, 1, HEADERS.length).setBackground('#FFF299');
  });
}

/** 숫자만 남기고, 앞자리 0 이 사라진 10자리(1로 시작)면 0 을 붙여 11자리로 복원 */
function normPhone_(val) {
  var d = String(val == null ? '' : val).replace(/[^0-9]/g, '');
  if (d.length === 10 && d.charAt(0) === '1') d = '0' + d;
  return d;
}
