/**
 * 접종·검진·행정 일정 계산 — 순수 함수만.
 * 생년월일과 "이미 한 것" 기록을 넣으면 날짜가 박힌 할 일 목록이 나온다.
 *
 * 핵심: 지연되면 그 다음 차수가 밀린다. 표준 개월 수만 보면 안 되고
 *       직전 차수의 "실제 접종일 + 최소간격" 과 비교해 늦은 쪽을 창 시작일로 잡는다.
 */

var ST_DONE     = 'done';      // 완료
var ST_OVERDUE  = 'overdue';   // 창이 지났는데 미완료
var ST_OPEN     = 'open';      // 지금 할 수 있음
var ST_SOON     = 'soon';      // 곧 열림 (기본 30일 이내)
var ST_FUTURE   = 'future';    // 아직 멂
var ST_SKIPPED  = 'skipped';   // 생략(선택접종 등)

var STATUS_LABEL = {
  done: '완료', overdue: '지남', open: '지금 가능', soon: '곧', future: '예정', skipped: '생략'
};

/** 창 정의 → 실제 날짜. earliestYmd 가 있으면 그보다 이르게 시작하지 않는다. */
function resolveWindow(birthYmd, spec, earliestYmd) {
  var start, end;
  if (spec.startD != null) start = addDays(birthYmd, spec.startD);
  else start = addMonths(birthYmd, spec.startM || 0);

  if (spec.endD != null) end = addDays(birthYmd, spec.endD);
  else {
    end = addMonths(birthYmd, spec.endM != null ? spec.endM : (spec.startM || 0));
    if (spec.endPlusD) end = addDays(end, spec.endPlusD);
  }
  if (earliestYmd && earliestYmd > start) start = earliestYmd;
  if (end < start) end = start;
  return { start: start, end: end };
}

/** 창 + 오늘 + 완료일 → 상태 */
function windowStatus(start, end, todayYmd, doneYmd, soonDays) {
  if (doneYmd) return ST_DONE;
  var soon = soonDays == null ? 30 : soonDays;
  if (todayYmd > end) return ST_OVERDUE;
  if (todayYmd >= start) return ST_OPEN;
  return daysBetween(todayYmd, start) <= soon ? ST_SOON : ST_FUTURE;
}

/**
 * 예방접종 계획표 생성.
 * @param {{birthDate:string}} child
 * @param {{rota:string, je:string, includeOptional:boolean}} options 백신 종류 선택
 * @param {Object} done  {'DTaP#2': '2025-06-03', ...} 실제 접종일
 * @param {string} todayYmd
 */
function buildVaccinePlan(child, options, done, todayYmd) {
  options = options || {};
  done = done || {};
  var out = [];

  for (var i = 0; i < VACCINE_SCHEDULE.length; i++) {
    var v = VACCINE_SCHEDULE[i];
    var doses = v.doses, variantKey = null, variantLabel = '';

    if (v.variants) {
      variantKey = options[v.series];
      if (!variantKey) {
        // 아직 어떤 백신으로 갈지 안 정했으면 선택을 요구하는 항목 하나만 내보낸다
        var opts = [];
        for (var k in v.variants) opts.push({ key: k, label: v.variants[k].label });
        out.push({ code: v.code, name: v.name, dose: 0, needsChoice: true,
                   choices: opts, status: ST_OPEN,
                   note: '백신 종류를 먼저 고르면 일정이 계산됩니다' });
        continue;
      }
      doses = v.variants[variantKey].doses;
      variantLabel = v.variants[variantKey].label;
    }

    var prevActual = null;
    for (var d = 0; d < doses.length; d++) {
      var spec = doses[d];
      var key = v.code + '#' + spec.n;
      var doneYmd = done[key] || null;

      var earliest = null;
      if (prevActual && spec.minPrevD) earliest = addDays(prevActual, spec.minPrevD);
      var w = resolveWindow(child.birthDate, spec, earliest);

      out.push({
        code: v.code, key: key, name: v.name, variant: variantLabel,
        dose: spec.n, totalDoses: doses.length,
        start: w.start, end: w.end,
        doneDate: doneYmd,
        status: windowStatus(w.start, w.end, todayYmd, doneYmd),
        nip: !!v.nip, annual: !!v.annual, note: spec.note || '',
        shifted: !!(earliest && earliest > (spec.startD != null
                    ? addDays(child.birthDate, spec.startD)
                    : addMonths(child.birthDate, spec.startM || 0)))
      });
      // 앞 차수를 아직 안 맞았으면 다음 차수는 표준일정 그대로 둔다
      // (실제 접종일이 없으면 최소간격을 계산할 근거가 없다)
      prevActual = doneYmd || null;
    }
  }
  return out;
}

/** 건강검진 계획표 */
function buildCheckupPlan(child, done, todayYmd) {
  done = done || {};
  var out = [];
  for (var i = 0; i < CHECKUP_SCHEDULE.length; i++) {
    var c = CHECKUP_SCHEDULE[i];
    var key = c.kind + '#' + c.n;
    var w = resolveWindow(child.birthDate, c, null);
    out.push({
      code: c.kind, key: key,
      name: c.kind === '구강' ? '영유아 구강검진 ' + c.n + '차' : '영유아 건강검진 ' + c.n + '차',
      dose: c.n, start: w.start, end: w.end,
      doneDate: done[key] || null,
      status: windowStatus(w.start, w.end, todayYmd, done[key]),
      note: c.note || '', free: true
    });
  }
  return out;
}

/** 행정 일정 */
function buildAdminPlan(child, done, todayYmd) {
  done = done || {};
  var out = [];
  for (var i = 0; i < ADMIN_SCHEDULE.length; i++) {
    var a = ADMIN_SCHEDULE[i];
    var w = resolveWindow(child.birthDate, a, null);
    out.push({
      code: 'admin', key: 'admin#' + a.code, name: a.name, dose: 0,
      start: w.start, end: w.end, doneDate: done['admin#' + a.code] || null,
      status: windowStatus(w.start, w.end, todayYmd, done['admin#' + a.code]),
      note: a.note || ''
    });
  }
  return out;
}

/** 세 계획을 합쳐 하나의 목록으로 */
function buildFullPlan(child, options, done, todayYmd) {
  return buildVaccinePlan(child, options, done, todayYmd)
    .concat(buildCheckupPlan(child, done, todayYmd))
    .concat(buildAdminPlan(child, done, todayYmd));
}

/**
 * 홈 화면용 묶음. 지난 것 → 지금 가능 → 곧, 순으로.
 * @param {number} horizonDays 며칠 앞까지 볼지 (기본 60)
 */
function planDigest(plan, todayYmd, horizonDays) {
  var horizon = horizonDays == null ? 60 : horizonDays;
  var g = { overdue: [], open: [], soon: [], done: [], later: [] };
  for (var i = 0; i < plan.length; i++) {
    var it = plan[i];
    if (it.status === ST_DONE) { g.done.push(it); continue; }
    if (it.status === ST_OVERDUE) { g.overdue.push(it); continue; }
    if (it.status === ST_OPEN) { g.open.push(it); continue; }
    if (daysBetween(todayYmd, it.start) <= horizon) g.soon.push(it);
    else g.later.push(it);
  }
  function byEnd(a, b) { return a.end < b.end ? -1 : a.end > b.end ? 1 : 0; }
  function byStart(a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; }
  g.overdue.sort(byEnd); g.open.sort(byEnd); g.soon.sort(byStart); g.later.sort(byStart);
  return g;
}

/** 마감까지 남은 일수. 지났으면 음수. */
function daysLeft(item, todayYmd) { return daysBetween(todayYmd, item.end); }

/** "D-12" / "D+3(지남)" */
function dDayText(item, todayYmd) {
  var n = daysLeft(item, todayYmd);
  if (item.doneDate) return '완료 ' + item.doneDate;
  if (n < 0) return 'D+' + (-n) + ' 지남';
  if (n === 0) return '오늘 마감';
  return 'D-' + n;
}

/** 마감 임박 경고가 필요한가 (무료 검진을 놓치면 돈이 든다) */
function needsAlert(item, todayYmd) {
  if (item.doneDate) return false;
  if (item.status === ST_OVERDUE) return true;
  return item.status === ST_OPEN && daysLeft(item, todayYmd) <= 21;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    resolveWindow: resolveWindow, windowStatus: windowStatus,
    buildVaccinePlan: buildVaccinePlan, buildCheckupPlan: buildCheckupPlan,
    buildAdminPlan: buildAdminPlan, buildFullPlan: buildFullPlan,
    planDigest: planDigest, daysLeft: daysLeft, dDayText: dDayText, needsAlert: needsAlert,
    ST_DONE: ST_DONE, ST_OVERDUE: ST_OVERDUE, ST_OPEN: ST_OPEN, ST_SOON: ST_SOON,
    ST_FUTURE: ST_FUTURE, STATUS_LABEL: STATUS_LABEL
  };
}
