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
var ADMIN_COL_BY = 10;   // J: 주문받은사람(누구한테 들어온 주문인지, 확인할 때 고른다)
var ADMIN_COL_AT = 11;   // K: 확인시각
var ADMIN_COL_MEMO = 12; // L: 메모 (주문 묶음의 첫 줄에만 적는다)
var ADMIN_COL_LOG = 13;  // M: 수정기록 (누가 언제 무엇을 고쳤는지)
var ADMIN_DONE = { '확인': true, '완료': true };   // 확인된 것으로 보는 상태

function adminPage_() {
  return HtmlService.createHtmlOutputFromFile('AdminPage')
    .setTitle('임가네 주문 확인')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 비밀번호가 맞으면 토큰을 돌려준다. 폰에는 비밀번호 대신 이 토큰만 저장된다. */
function adminLogin(password) {
  var cache = CacheService.getScriptCache();
  var fails = parseInt(cache.get('adminFails') || '0', 10);
  if (fails >= 10) throw new Error('비밀번호가 여러 번 틀려 10분 동안 잠겼어요. 잠시 후 다시 해주세요.');
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
  if (last < 2) return { groups: [], inbox: adminInbox_() };
  var width = Math.max(sh.getLastColumn(), ADMIN_COL_LOG);
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
      note: note, status: r[8], by: r[ADMIN_COL_BY - 1], at: r[ADMIN_COL_AT - 1],
      memo: r[ADMIN_COL_MEMO - 1] || '', log: r[ADMIN_COL_LOG - 1] || ''
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
    g.memo = (g.items[0] && g.items[0].memo) || '';
    g.log = g.items.map(function (it) { return it.log; }).filter(function (t) { return t; }).join('\n');
    return g;
  });
  groups.sort(function (a, b) { return b.lastRow - a.lastRow; });
  return { groups: groups, inbox: adminInbox_() };
}

/** '주문접수' 탭 전체(헤더 포함)를 화면에 보이는 그대로의 글자로 돌려준다 — 엑셀 내려받기용. 다른 탭은 건드리지 않는다. */
function adminExport(token) {
  adminCheck_(token);
  var sh = adminSheet_();
  var last = sh.getLastRow();
  if (last < 1) return { rows: [] };
  var width = Math.max(sh.getLastColumn(), ADMIN_COL_LOG);
  return { rows: sh.getRange(1, 1, last, width).getDisplayValues() };
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
  var h = sh.getRange(1, ADMIN_COL_BY, 1, 4).getValues()[0];
  var want = ['주문받은사람', '확인시각', '메모', '수정기록'];
  var out = h.map(function (t, k) { return t || want[k]; });
  if (out.join('|') !== h.join('|')) sh.getRange(1, ADMIN_COL_BY, 1, 4).setValues([out]);
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
 * 주문 고치기·메모. edits = [{row, sig, name?, phone?, qty?, addr?, note?, sname?, sphone?, memo?}]
 * 줄이 그사이 바뀌었으면(sig 불일치) 그 줄은 건너뛴다. 글자는 있는 그대로 적고(앞뒤 공백만 정리),
 * 자동 검증은 전화번호 11자리와 수량(1 이상 숫자)뿐이다. 상태가 접수/확인필요면 빠진 칸에 맞춰 다시 정한다.
 * 누가 무엇을 고쳤는지는 M열 수정기록에 남긴다.
 */
var ADMIN_WHO = ['아빠', '엄마', '종원', '지은', '명석'];
var ADMIN_FIELD_LABEL = { name: '받는사람', phone: '받는분전화', qty: '수량', addr: '주소', note: '비고',
                          sname: '보내는사람', sphone: '보내는분전화', memo: '메모' };
function adminEdit(token, edits, who) {
  adminCheck_(token);
  who = String(who || '').trim();
  if (ADMIN_WHO.indexOf(who) === -1) throw new Error('누가 고쳤는지 먼저 눌러주세요.');
  var clean = function (t) { return String(t == null ? '' : t).replace(/\r/g, '').trim(); };
  var digits = function (t) { return String(t == null ? '' : t).replace(/[^0-9]/g, ''); };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = adminSheet_();
    adminEnsureCols_(sh);
    var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'MM-dd HH:mm');
    var plan = [], skipped = 0;

    (edits || []).forEach(function (e) {
      var row = parseInt(e && e.row, 10);
      if (!(row >= 2) || row > sh.getLastRow()) { skipped++; return; }
      var r = sh.getRange(row, 1, 1, ADMIN_COL_LOG).getDisplayValues()[0];
      if (adminSig_(r) !== e.sig) { skipped++; return; }
      var cur = { name: r[1], phone: r[2], qty: r[3], addr: r[4], sname: r[5], sphone: r[6], memo: r[ADMIN_COL_MEMO - 1] };
      var oldNote = r[7] || '';
      var mail = (oldNote.match(/\[메일:[^\]]*\]/) || [''])[0];
      cur.note = oldNote.replace(/\[메일:[^\]]*\]/g, '').replace(/\[미비:[^\]]*\]/g, '').trim();

      var next = {}, changes = [];
      Object.keys(ADMIN_FIELD_LABEL).forEach(function (k) {
        if (e[k] === undefined) { next[k] = cur[k]; return; }
        var v = clean(e[k]);
        if ((k === 'phone' || k === 'sphone') && v) {
          if (digits(v).length !== 11 || digits(v) !== v.replace(/[^0-9]/g, '')) throw new Error('전화번호는 숫자 11자리로 적어주세요.');
          v = digits(v);
        }
        if (k === 'qty' && v && !/^[0-9]+$/.test(v)) throw new Error('수량은 숫자로 적어주세요.');
        if (k === 'qty' && v && parseInt(v, 10) < 1) throw new Error('수량은 1 이상이어야 해요.');
        next[k] = v;
        if (v !== String(cur[k] || '')) {
          var show = function (t) { t = String(t || '').replace(/\s+/g, ' '); return t ? (t.length > 28 ? t.slice(0, 28) + '…' : t) : '(빔)'; };
          changes.push(ADMIN_FIELD_LABEL[k] + (k === 'memo' ? ' 수정' : ' ' + show(cur[k]) + '→' + show(v)));
        }
      });
      if (!changes.length) return;

      var miss = [];
      if (!next.phone) miss.push('받는분전화');
      if (!next.qty || !/^[0-9]+$/.test(next.qty) || parseInt(next.qty, 10) < 1) miss.push('수량');
      if (!next.addr) miss.push('주소');
      if (!next.sname) miss.push('보내는사람');
      if (!next.sphone) miss.push('보내는분전화');
      plan.push({ row: row, r: r, next: next, changes: changes, mail: mail, miss: miss });
    });

    var updated = 0;
    plan.forEach(function (p) {
      var n = p.next, status = p.r[8];
      if (status === '접수' || status === '확인필요') status = p.miss.length ? '확인필요' : '접수';
      var note = [n.note, p.mail, p.miss.length ? '[미비:' + p.miss.join(',') + ']' : ''].filter(function (t) { return t; }).join(' ');
      sh.getRange(p.row, 3).setNumberFormat('@');
      sh.getRange(p.row, 7).setNumberFormat('@');
      sh.getRange(p.row, ADMIN_COL_MEMO).setNumberFormat('@');
      sh.getRange(p.row, 2, 1, 7).setValues([[n.name, n.phone, n.qty, n.addr, n.sname, n.sphone, note]]);
      sh.getRange(p.row, 9).setValue(status);
      sh.getRange(p.row, ADMIN_COL_MEMO).setValue(n.memo);
      var line = now + ' ' + who + ': ' + p.changes.join(', ');
      var log = (p.r[ADMIN_COL_LOG - 1] ? p.r[ADMIN_COL_LOG - 1] + '\n' : '') + line;
      if (log.length > 1500) log = log.slice(log.length - 1500);
      sh.getRange(p.row, ADMIN_COL_LOG).setValue(log);
      var yellow = status === '확인필요';
      sh.getRange(p.row, 1, 1, ADMIN_COL_LOG).setBackground(yellow ? '#FFF299' : null);
      updated++;
    });
    return { updated: updated, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

/** '미분류' 탭에서 상태가 '대기'인 메일이 몇 통인지만 센다 (내용은 화면으로 보내지 않는다) */
function adminInbox_() {
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(INBOX_SHEET);
  if (!sh || sh.getLastRow() < 2) return 0;
  var v = sh.getRange(2, 7, sh.getLastRow() - 1, 1).getDisplayValues();
  return v.filter(function (r) { return r[0] === '대기'; }).length;
}
