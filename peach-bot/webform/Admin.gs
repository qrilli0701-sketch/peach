/**
 * 가족용 관리자 화면 — 웹앱 주소 뒤에 ?admin 을 붙이면 열린다.
 * '주문접수' 탭을 손님이 한 번 제출한 단위(같은 접수시각·보내는분)로 묶어 보여주고,
 * 가족이 '확인'을 누르면 상태를 '확인'으로 바꾸고 J열(확인자)·K열(확인시각)에 남긴다.
 *
 * [설정] 비밀번호는 스크립트 속성 ADMIN_PASSWORD 에 있다 (편집기 ⚙ 프로젝트 설정 → 스크립트 속성).
 *        처음엔 clasp 로 배포하는 쪽이 git 에 안 올라가는 AdminSecret.gs 에
 *        var ADMIN_PASSWORD_INIT = '...'; 를 만들어 함께 push 하면, 첫 로그인 때 속성으로 옮겨진다.
 *        레포가 공개라 비밀번호는 코드·레포에 넣지 않는다. 바꾸면 모든 폰이 다시 로그인해야 한다.
 */
var ADMIN_COL_BY = 10;   // J: 확인자
var ADMIN_COL_AT = 11;   // K: 확인시각
var ADMIN_DONE = { '확인': true, '완료': true };   // 확인된 것으로 보는 상태

function adminPage_() {
  return HtmlService.createHtmlOutputFromFile('AdminPage')
    .setTitle('임가네 주문 확인')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 비밀번호가 맞으면 토큰을 돌려준다. 폰에는 비밀번호 대신 이 토큰만 저장된다. */
function adminLogin(password, name) {
  var cache = CacheService.getScriptCache();
  var fails = parseInt(cache.get('adminFails') || '0', 10);
  if (fails >= 10) throw new Error('비밀번호가 여러 번 틀려 10분 동안 잠겼어요. 잠시 후 다시 해주세요.');
  if (!(name || '').trim()) throw new Error('이름을 적어주세요.');
  if (String(password || '') !== adminPassword_()) {
    cache.put('adminFails', String(fails + 1), 600);
    throw new Error('비밀번호가 맞지 않아요.');
  }
  return { token: adminToken_() };
}

/** 주문 목록 (묶음 단위, 최신순) */
function adminList(token) {
  adminCheck_(token);
  var sh = adminSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { groups: [] };
  var width = Math.max(sh.getLastColumn(), ADMIN_COL_AT);
  var v = sh.getRange(2, 1, last - 1, width).getDisplayValues();

  var map = {}, order = [];
  v.forEach(function (r, i) {
    if (!r[1] && !r[0]) return;                       // 빈 줄
    var row = i + 2;
    var key = [r[0], r[5], r[6]].join('|');           // 접수시각 + 보내는사람 + 보내는분전화
    var g = map[key];
    if (!g) {
      g = map[key] = { key: key, time: r[0], sender: r[5], senderPhone: r[6],
                       mail: false, items: [], lastRow: row };
      order.push(g);
    }
    var note = r[7] || '';
    if (note.indexOf('[메일:') !== -1) g.mail = true;
    g.lastRow = row;
    g.items.push({
      row: row, sig: adminSig_(r), name: r[1], phone: r[2], qty: r[3], addr: r[4],
      note: note, status: r[8], by: r[ADMIN_COL_BY - 1], at: r[ADMIN_COL_AT - 1]
    });
  });

  var groups = order.map(function (g) {
    var boxes = 0, done = 0, warn = false, by = '', at = '', sheet1 = false;
    g.items.forEach(function (it) {
      var q = parseInt(it.qty, 10);
      if (q > 0) boxes += q;
      if (ADMIN_DONE[it.status]) {
        done++;
        if (!by && it.by) { by = it.by; at = it.at; }
        if (it.status === '완료') sheet1 = true;
      }
      if (it.status === '확인필요' || it.note.indexOf('[미비:') !== -1) warn = true;
    });
    g.boxes = boxes;
    g.checked = done === g.items.length;
    g.warn = warn;
    g.by = by;
    g.at = at;
    g.sheet1 = sheet1;
    return g;
  });
  var prev = adminPrevMap_();
  groups.forEach(function (g) {
    var ph = String(g.senderPhone || '').replace(/[^0-9]/g, '');
    g.prev = (prev.sender[ph] || prev.recv[ph] || []);   // 작년(26년)에 이 번호의 주문을 받았던 사람들
  });
  groups.sort(function (a, b) { return b.lastRow - a.lastRow; });
  return { groups: groups };
}

/** 확인 처리. items = [{row, sig}] — 그사이 시트 줄이 바뀌었으면 그 줄은 건너뛴다. */
function adminConfirm(token, items, name) {
  adminCheck_(token);
  name = String(name || '').trim().slice(0, 20) || '가족';
  var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  return adminUpdate_(items, function (r) {
    if (ADMIN_DONE[r[8]]) return null;
    return { status: '확인', by: name, at: now };
  });
}

/** 확인 취소 — 상태를 원래대로(누락 표시가 있으면 '확인필요', 아니면 '접수') 되돌린다. '완료'는 건드리지 않는다. */
function adminUnconfirm(token, items) {
  adminCheck_(token);
  return adminUpdate_(items, function (r) {
    if (r[8] !== '확인') return null;
    return { status: (r[7] || '').indexOf('[미비:') !== -1 ? '확인필요' : '접수', by: '', at: '' };
  });
}

function adminUpdate_(items, decide) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = adminSheet_();
    adminEnsureCols_(sh);
    var updated = 0, skipped = 0;
    (items || []).forEach(function (it) {
      var row = parseInt(it && it.row, 10);
      if (!(row >= 2) || row > sh.getLastRow()) { skipped++; return; }
      var r = sh.getRange(row, 1, 1, ADMIN_COL_AT).getDisplayValues()[0];
      if (adminSig_(r) !== it.sig) { skipped++; return; }   // 줄이 밀렸거나 지워짐
      var ch = decide(r);
      if (!ch) return;
      sh.getRange(row, 9).setValue(ch.status);
      sh.getRange(row, ADMIN_COL_BY, 1, 2).setNumberFormat('@').setValues([[ch.by, ch.at]]);
      updated++;
    });
    return { updated: updated, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function adminSheet_() {
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  if (!sh) throw new Error("'" + SHEET_NAME + "' 탭을 찾을 수 없어요.");
  return sh;
}

function adminEnsureCols_(sh) {
  var h = sh.getRange(1, ADMIN_COL_BY, 1, 2).getValues()[0];
  if (!h[0] || !h[1]) sh.getRange(1, ADMIN_COL_BY, 1, 2).setValues([['확인자', '확인시각']]);
}

/** 한 줄을 알아보는 표식: 접수시각 + 받는사람 + 받는분전화 */
function adminSig_(r) {
  return [r[0], r[1], r[2]].join('|');
}

function adminPassword_() {
  var props = PropertiesService.getScriptProperties();
  var pw = props.getProperty('ADMIN_PASSWORD');
  // 처음 한 번: 배포할 때만 만드는 AdminSecret.gs(git 제외)의 ADMIN_PASSWORD_INIT 를 스크립트 속성으로 옮긴다.
  // 그 뒤로는 파일이 없어져도 스크립트 속성에 남아 있다. (레포가 공개라 비밀번호를 코드에 두지 않음)
  if (!pw && typeof ADMIN_PASSWORD_INIT !== 'undefined' && ADMIN_PASSWORD_INIT) {
    pw = String(ADMIN_PASSWORD_INIT);
    props.setProperty('ADMIN_PASSWORD', pw);
  }
  if (!pw) throw new Error('관리자 비밀번호가 아직 설정되지 않았어요. (스크립트 속성 ADMIN_PASSWORD)');
  return pw;
}

function adminToken_() {
  var sig = Utilities.computeHmacSha256Signature('peach-admin', adminPassword_());
  return Utilities.base64EncodeWebSafe(sig);
}

function adminCheck_(token) {
  if (!token || token !== adminToken_()) throw new Error('AUTH');
}

/**
 * '26년주문받은사람' 탭(구분·이름·전화번호·주문받은사람·건수)을 읽어 전화번호 → 받았던 사람 목록으로 만든다.
 * 보낸분 번호를 먼저, 없으면 받는분 번호로 찾는다. 탭이 없으면 빈 결과(화면에 표시만 안 됨).
 * 주문받은사람 칸은 '엄마' 또는 '아빠2/엄마2'(여러 명이면 많은 순) 형식.
 */
function adminPrevMap_() {
  var out = { sender: {}, recv: {} };
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('26년주문받은사람');
    if (!sh || sh.getLastRow() < 2) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, 4).getDisplayValues().forEach(function (r) {
      var ph = String(r[2] || '').replace(/[^0-9]/g, '');
      if (!ph) return;
      var names = String(r[3] || '').split('/').map(function (t) { return t.replace(/[0-9\s]/g, ''); })
                                      .filter(function (t) { return t; });
      (r[0] === '보낸분' ? out.sender : out.recv)[ph] = names;
    });
  } catch (e) {}
  return out;
}
