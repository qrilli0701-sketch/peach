/**
 * Apps Script 런타임 흉내 — 시트를 메모리 2차원 배열로 두고 Api.gs 를 실제로 돌려본다.
 * 편집기에 붙여넣기 전에 런타임 오류를 잡는 게 목적이다. 완전한 재현이 아니라
 * 이 프로젝트가 실제로 쓰는 메서드만 구현한다.
 */
const MAX_ROWS = 1000;

function makeSheet(name) {
  const data = [];                       // data[r][c], 0-index
  const get = (r, c) => (data[r] && data[r][c] !== undefined) ? data[r][c] : '';
  const set = (r, c, v) => {
    while (data.length <= r) data.push([]);
    while (data[r].length <= c) data[r].push('');
    data[r][c] = v;
  };
  const lastRow = () => {
    for (let r = data.length - 1; r >= 0; r--) {
      if ((data[r] || []).some(v => v !== '' && v != null)) return r + 1;
    }
    return 0;
  };
  const lastCol = () => {
    let m = 0;
    for (const row of data) {
      for (let c = (row || []).length - 1; c >= 0; c--) {
        if (row[c] !== '' && row[c] != null) { m = Math.max(m, c + 1); break; }
      }
    }
    return m;
  };

  function range(r0, c0, nr, nc) {
    nr = nr || 1; nc = nc || 1;
    const api = {
      getValues() {
        const out = [];
        for (let r = 0; r < nr; r++) {
          const row = [];
          for (let c = 0; c < nc; c++) row.push(get(r0 - 1 + r, c0 - 1 + c));
          out.push(row);
        }
        return out;
      },
      setValues(vals) {
        if (vals.length !== nr) throw new Error(`setValues 행 수 불일치: ${vals.length} != ${nr}`);
        for (let r = 0; r < nr; r++) {
          if (vals[r].length !== nc) throw new Error(`setValues 열 수 불일치: ${vals[r].length} != ${nc}`);
          for (let c = 0; c < nc; c++) set(r0 - 1 + r, c0 - 1 + c, vals[r][c]);
        }
        return api;
      },
      setValue(v) { set(r0 - 1, c0 - 1, v); return api; },
      setNumberFormat() { return api; },
      setFontWeight() { return api; },
      setBackground() { return api; }
    };
    return api;
  }

  return {
    getName: () => name,
    getRange: range,
    getDataRange: () => range(1, 1, Math.max(lastRow(), 1), Math.max(lastCol(), 1)),
    getLastRow: lastRow,
    getLastColumn: lastCol,
    getMaxRows: () => MAX_ROWS,
    setFrozenRows() { return this; },
    appendRow(row) {
      const r = lastRow();
      for (let c = 0; c < row.length; c++) set(r, c, row[c]);
      return this;
    },
    deleteRow(r) { data.splice(r - 1, 1); return this; },
    _dump: () => JSON.parse(JSON.stringify(data))
  };
}

function pad(n, w) { return String(n).padStart(w || 2, '0'); }

function makeEnv(opts) {
  opts = opts || {};
  const sheets = {};
  const spreadsheet = {
    getName: () => '아이관리(테스트)',
    getSpreadsheetTimeZone: () => 'Asia/Seoul',
    setSpreadsheetTimeZone() { return this; },
    getSheetByName: n => sheets[n] || null,
    insertSheet(n) { sheets[n] = makeSheet(n); return sheets[n]; }
  };

  // 테스트가 '오늘'을 마음대로 정할 수 있게 한다
  const env = { _now: opts.now ? new Date(opts.now + 'T09:00:00Z') : new Date() };

  env.SpreadsheetApp = { openById: () => spreadsheet, flush() {} };
  env.Utilities = {
    formatDate(d, tz, fmt) {
      const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
      const h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
      switch (fmt) {
        case 'yyyy-MM-dd': return `${Y}-${pad(M)}-${pad(D)}`;
        case 'yyyy-MM-dd HH:mm': return `${Y}-${pad(M)}-${pad(D)} ${pad(h)}:${pad(m)}`;
        case 'yyMMddHHmmss': return `${pad(Y % 100)}${pad(M)}${pad(D)}${pad(h)}${pad(m)}${pad(s)}`;
        case 'yyyyMMdd': return `${Y}${pad(M)}${pad(D)}`;
        default: throw new Error('mock: 모르는 날짜 형식 ' + fmt);
      }
    }
  };
  const email = opts.email || 'papa@example.com';
  const user = { getEmail: () => email };
  env.Session = { getActiveUser: () => user, getEffectiveUser: () => user };
  env.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  env.Logger = { log() {} };
  env.HtmlService = {
    createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; },
      addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } }) }),
    XFrameOptionsMode: { ALLOWALL: 1 }
  };
  env.sentMail = [];
  env.MailApp = { sendEmail(o) { env.sentMail.push(o); } };
  env.calendarEvents = [];
  const evt = title => ({ _title: title, _tags: {}, setTag(k, v) { this._tags[k] = v; return this; },
                          getTag(k) { return this._tags[k]; }, deleteEvent() { this._deleted = true; } });
  const cal = {
    createAllDayEvent(title, date, opts) {
      const e = evt(title); e._date = date; e._opts = opts; env.calendarEvents.push(e); return e;
    },
    getEvents: () => env.calendarEvents.filter(e => !e._deleted)
  };
  env.CalendarApp = { getDefaultCalendar: () => cal, getCalendarById: () => cal };
  env.ScriptApp = {
    getProjectTriggers: () => [],
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' })
  };
  env._sheets = sheets;
  env._setNow = ymd => { env._now = new Date(ymd + 'T09:00:00Z'); };

  // Date 를 고정할 수 있게 감싼다
  const RealDate = Date;
  env.Date = function (...args) {
    if (args.length === 0) return new RealDate(env._now.getTime());
    return new RealDate(...args);
  };
  env.Date.prototype = RealDate.prototype;
  env.Date.UTC = RealDate.UTC;
  env.Date.now = () => env._now.getTime();

  return env;
}

module.exports = { makeEnv, makeSheet };
