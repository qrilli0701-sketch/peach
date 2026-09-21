/**
 * 구글시트를 테이블처럼 쓰기 위한 얇은 접근 계층.
 * 모든 쓰기는 LockService 로 직렬화한다 — 부부가 동시에 기록할 수 있으므로.
 */

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('시트 탭이 없습니다: ' + name + ' — setupSheets() 를 먼저 실행하세요');
  return sh;
}

/** 전체를 객체 배열로. 빈 행은 건너뛴다. */
function readTable(name) {
  var sh = sheet_(name);
  if (sh.getLastRow() < 2) return [];
  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var headers = values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r], blank = true, obj = { _row: r + 1 };
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = row[c];
      if (v instanceof Date) v = Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
      if (v !== '' && v !== null) blank = false;
      obj[headers[c]] = v;
    }
    if (!blank) out.push(obj);
  }
  return out;
}

function headersOf_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

/** 객체 한 건 추가. 헤더에 없는 키는 무시한다. */
function appendRow(name, obj) {
  return withLock_(function () {
    var sh = sheet_(name);
    var headers = headersOf_(sh);
    var row = headers.map(function (h) { return obj[h] != null ? obj[h] : ''; });
    sh.appendRow(row);
    return obj;
  });
}

/** idColumn 값이 일치하는 행을 patch 의 키만 갱신. 없으면 null. */
function updateRow(name, idColumn, idValue, patch) {
  return withLock_(function () {
    var sh = sheet_(name);
    var headers = headersOf_(sh);
    var idx = headers.indexOf(idColumn);
    if (idx < 0) throw new Error(name + ' 에 ' + idColumn + ' 열이 없습니다');
    if (sh.getLastRow() < 2) return null;

    var ids = sh.getRange(2, idx + 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) !== String(idValue)) continue;
      var r = i + 2;
      var row = sh.getRange(r, 1, 1, headers.length).getValues()[0];
      for (var c = 0; c < headers.length; c++) {
        if (patch.hasOwnProperty(headers[c])) row[c] = patch[headers[c]];
      }
      sh.getRange(r, 1, 1, headers.length).setValues([row]);
      return row;
    }
    return null;
  });
}

/** 있으면 갱신, 없으면 추가 */
function upsertRow(name, idColumn, idValue, obj) {
  var updated = updateRow(name, idColumn, idValue, obj);
  if (updated) return updated;
  return appendRow(name, obj);
}

function deleteRow(name, idColumn, idValue) {
  return withLock_(function () {
    var sh = sheet_(name);
    var headers = headersOf_(sh);
    var idx = headers.indexOf(idColumn);
    if (sh.getLastRow() < 2) return false;
    var ids = sh.getRange(2, idx + 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]) === String(idValue)) { sh.deleteRow(i + 2); return true; }
    }
    return false;
  });
}

/** 여러 열을 키로 삼아 한 행을 지운다 (일정완료: 아이ID + 항목키) */
function deleteWhere(name, match) {
  return withLock_(function () {
    var sh = sheet_(name);
    if (sh.getLastRow() < 2) return false;
    var headers = headersOf_(sh);
    var values = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var ok = true;
      for (var k in match) {
        var c = headers.indexOf(k);
        if (c < 0 || String(values[i][c]) !== String(match[k])) { ok = false; break; }
      }
      if (ok) { sh.deleteRow(i + 2); return true; }
    }
    return false;
  });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('다른 요청 처리 중입니다. 잠시 후 다시 시도해 주세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ── 설정 ─────────────────────────────────────────────── */

function getSetting(key, fallback) {
  var rows = readTable('설정');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]['키'] === key) return rows[i]['값'];
  }
  return fallback == null ? '' : fallback;
}

/* ── 공통 ─────────────────────────────────────────────── */

function newId(prefix) {
  return prefix + '-' + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') +
         '-' + Math.floor(Math.random() * 1000);
}

function todayYmd() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowStamp() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }

/** 숫자로 못 바꾸면 null */
function num_(v) {
  if (v === '' || v == null) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
