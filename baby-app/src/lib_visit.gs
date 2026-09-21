/**
 * 방문 묶기 — 이 앱이 존재하는 이유.
 *
 * 접종·검진은 각각 "언제부터 언제까지" 창이 있고, 그 창들은 서로 겹친다.
 * 할 일을 목록으로 늘어놓으면 부모가 직접 겹치는 날을 찾아내야 한다.
 * 여기서는 반대로 한다 — 창이 가장 많이 겹치는 날을 찾아
 * "이 날 병원 한 번 가면 6개가 끝납니다" 로 바꾼다.
 *
 * 지키는 규칙
 *   1. 창을 벗어난 날에는 배정하지 않는다 (start <= 방문일 <= end)
 *   2. 주사용 생백신(MMR·수두·일본뇌염 생백신)은 같은 날 함께 맞거나 4주 간격
 *   3. 일요일은 피한다 (문 연 소아과가 드물다)
 *   4. 마감이 급한 것을 먼저 챙긴다
 *
 * 순수 함수만 — lib_growth.gs 의 날짜 함수에 의존한다.
 */

var VISIT_HORIZON_DAYS = 150;   // 이 앞까지만 계획을 세운다
var VISIT_MAX = 4;              // 너무 많으면 계획이 아니라 목록이 된다

/**
 * 묶으려고 미룰 수 있는 최대 일수.
 * 방문 수만 줄이려 들면 독감 2차가 유행 정점 뒤로 밀리는 식이 된다.
 * 창이 아무리 길어도 열린 지 이만큼 지나면 따로라도 간다.
 */
var VISIT_MAX_DELAY_DAYS = 42;
var WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** 'yyyy-MM-dd' → 0(일) ~ 6(토) */
function weekdayOf(ymd) {
  return new Date(ymdToUtc(ymd)).getUTCDay();
}

function weekdayLabel(ymd) {
  return WEEKDAY_KO[weekdayOf(ymd)];
}

/** 방문 묶기 대상인가 — 완료·선택대기·권고 항목은 병원에 갈 일이 아니다 */
function isVisitable_(it) {
  return !it.doneDate && !it.needsChoice && !it.advisory && !!it.start && !!it.end;
}

/**
 * 방문 계획 세우기.
 * @param {Array} plan buildFullPlan() 결과
 * @param {string} todayYmd
 * @param {{horizonDays:number, maxVisits:number}} opts
 * @return {{visits:Array, later:Array, unschedulable:Array}}
 *   visits[i] = { date, weekday, items:[], liveCount, earliestDeadline, overdueCount }
 */
function planVisits(plan, todayYmd, opts) {
  opts = opts || {};
  var horizon = addDays(todayYmd, opts.horizonDays || VISIT_HORIZON_DAYS);
  var maxVisits = opts.maxVisits || VISIT_MAX;

  var pending = [], later = [];
  for (var i = 0; i < plan.length; i++) {
    var it = plan[i];
    if (!isVisitable_(it)) continue;
    if (it.start > horizon) { later.push(it); continue; }
    pending.push(it);
  }

  // 같은 백신의 앞 차수를 어느 방문에 넣었는지 — 뒤 차수는 그만큼 밀어야 한다
  var placed = {};

  // 항목별 '이 날짜를 넘겨서까지 묶지는 않는다' 선
  var limit = {};
  for (var q = 0; q < pending.length; q++) {
    limit[pending[q].key] = batchDeadline_(pending[q], todayYmd, opts.maxDelayDays);
  }

  var visits = [];
  var guard = 0;
  while (pending.length && visits.length < maxVisits && guard++ < 50) {
    var pick = bestDate_(pending, todayYmd, horizon, visits, placed, limit);
    if (!pick) break;

    var taken = [], rest = [], usedCodes = {};
    // 마감이 급한 것부터 자리를 잡는다 (한 방문에 같은 백신은 한 번만 들어간다)
    var order = pending.slice().sort(function (a, b) {
      return a.end < b.end ? -1 : a.end > b.end ? 1 : (a.dose || 0) - (b.dose || 0);
    });
    for (var j = 0; j < order.length; j++) {
      var p = order[j];
      if (fitsOn_(p, pick.date, visits, placed, usedCodes, limit)) {
        if (p.code) usedCodes[p.code] = true;
        taken.push(p);
      } else {
        rest.push(p);
      }
    }
    if (!taken.length) break;

    for (var t = 0; t < taken.length; t++) {
      if (taken[t].code) placed[taken[t].code] = pick.date;
    }
    // 앞 차수를 잡았으면 뒤 차수의 '너무 미루지 않기' 선도 그 시점부터 다시 센다
    for (var u = 0; u < rest.length; u++) {
      var nxt = rest[u], prevDate = placed[nxt.code];
      if (!prevDate || !nxt.minPrevD) continue;
      var earliest = addDays(prevDate, nxt.minPrevD);
      var anchor = earliest > todayYmd ? earliest : todayYmd;
      var capped = addDays(anchor, opts.maxDelayDays == null ? VISIT_MAX_DELAY_DAYS : opts.maxDelayDays);
      limit[nxt.key] = capped < nxt.end ? capped : nxt.end;
      if (nxt.start < earliest) nxt.start = earliest;
    }
    visits.push(makeVisit_(pick.date, taken));
    pending = rest;
  }

  visits.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  return { visits: visits, later: later, unschedulable: pending };
}

/**
 * 묶기 목적의 '실질 마감' — 실제 마감과 '너무 미루지 않기' 상한 중 이른 쪽.
 * 기준점은 창 시작일이되, 이미 지난 창이면 오늘부터 센다.
 */
function batchDeadline_(item, todayYmd, maxDelay) {
  var anchor = item.start > todayYmd ? item.start : todayYmd;
  var capped = addDays(anchor, maxDelay == null ? VISIT_MAX_DELAY_DAYS : maxDelay);
  return capped < item.end ? capped : item.end;
}

/**
 * 이 항목을 이 날짜에 넣을 수 있는가.
 *   - 창 안이어야 한다
 *   - 한 방문에 같은 백신 두 차수를 넣을 수 없다
 *   - 같은 백신의 앞 차수를 이미 배정했다면 최소간격을 지켜야 한다
 *   - 주사용 생백신은 다른 생백신 방문과 4주 이상 떨어져야 한다
 */
function fitsOn_(item, date, visits, placed, usedCodes, limit) {
  if (item.start > date || date > item.end) return false;
  if (limit && date > limit[item.key]) return false;
  if (usedCodes && item.code && usedCodes[item.code]) return false;
  var prev = placed && placed[item.code];
  if (prev && item.minPrevD && daysBetween(prev, date) < item.minPrevD) return false;
  if (item.live && !liveOk_(date, visits)) return false;
  return true;
}

/** 이 날짜에 생백신을 넣어도 기존 방문들과 4주 규칙을 어기지 않는가 */
function liveOk_(date, visits) {
  for (var i = 0; i < visits.length; i++) {
    if (!visits[i].liveCount) continue;
    var gap = Math.abs(daysBetween(visits[i].date, date));
    if (gap !== 0 && gap < LIVE_VACCINE_MIN_GAP_DAYS) return false;
  }
  return true;
}

/**
 * 가장 많은 항목을 덮는 날짜를 고른다.
 * 후보는 각 항목의 창 시작일(과 오늘) — 그 사이 날짜를 고를 이유가 없다.
 */
function bestDate_(pending, todayYmd, horizon, visits, placed, limit) {
  var seen = {}, candidates = [];
  function add(d) {
    if (!d || d < todayYmd || d > horizon || seen[d]) return;
    seen[d] = true; candidates.push(d);
  }
  add(todayYmd);
  for (var i = 0; i < pending.length; i++) {
    add(pending[i].start);
    var prev = placed && placed[pending[i].code];
    if (prev && pending[i].minPrevD) add(addDays(prev, pending[i].minPrevD));
  }

  var best = null;
  for (var c = 0; c < candidates.length; c++) {
    var d = shiftOffSunday_(candidates[c], pending);
    if (!d || seen['@' + d]) continue;
    seen['@' + d] = true;

    var count = 0, earliestEnd = null, overdue = 0, used = {};
    var byEnd = pending.slice().sort(function (a, b) {
      return a.end < b.end ? -1 : a.end > b.end ? 1 : (a.dose || 0) - (b.dose || 0);
    });
    for (var k = 0; k < byEnd.length; k++) {
      var p = byEnd[k];
      if (!fitsOn_(p, d, visits, placed, used, limit)) continue;
      if (p.code) used[p.code] = true;
      count++;
      if (p.status === ST_OVERDUE) overdue++;
      if (earliestEnd == null || p.end < earliestEnd) earliestEnd = p.end;
    }
    if (!count) continue;

    var cand = { date: d, count: count, overdue: overdue, earliestEnd: earliestEnd };
    if (!best || betterThan_(cand, best)) best = cand;
  }
  return best;
}

/**
 * 더 좋은 후보인가.
 * 마감이 지난 걸 많이 처리하는 날 > 한 번에 많이 끝나는 날 > 이른 날
 */
function betterThan_(a, b) {
  if (a.overdue !== b.overdue) return a.overdue > b.overdue;
  if (a.count !== b.count) return a.count > b.count;
  return a.date < b.date;
}

/** 일요일이면 월요일로 민다. 단 그러다 창을 벗어나는 항목이 생기면 그냥 둔다. */
function shiftOffSunday_(date, pending) {
  if (weekdayOf(date) !== 0) return date;
  var next = addDays(date, 1);
  var coveredBefore = 0, coveredAfter = 0;
  for (var i = 0; i < pending.length; i++) {
    var p = pending[i];
    if (p.start <= date && date <= p.end) coveredBefore++;
    if (p.start <= next && next <= p.end) coveredAfter++;
  }
  return coveredAfter >= coveredBefore ? next : date;
}

function makeVisit_(date, items) {
  items.sort(function (a, b) { return a.end < b.end ? -1 : a.end > b.end ? 1 : 0; });
  var live = 0, overdue = 0;
  for (var i = 0; i < items.length; i++) {
    if (items[i].live) live++;
    if (items[i].status === ST_OVERDUE) overdue++;
  }
  return {
    date: date, weekday: weekdayLabel(date), items: items,
    liveCount: live, overdueCount: overdue,
    earliestDeadline: items.length ? items[0].end : null
  };
}

/* ── 사람 말로 ───────────────────────────────────────── */

/** "10월 5일 (월)" */
function visitDateLabel(ymd) {
  var m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return Number(m[1]) + '월 ' + Number(m[2]) + '일 (' + weekdayLabel(ymd) + ')';
}

/** 방문 한 건을 한 줄로 요약 */
function visitSummary(visit, todayYmd) {
  var n = visit.items.length;
  var when = daysBetween(todayYmd, visit.date);
  var head = when <= 0 ? '오늘 가시면' : when === 1 ? '내일 가시면' : when + '일 뒤에 가시면';
  return head + ' ' + n + '개가 끝납니다';
}

/**
 * 왜 이 날인지 한 줄로. 부모가 납득해야 움직인다.
 */
function visitReason(visit, todayYmd) {
  if (visit.overdueCount) {
    return '이미 기한이 지난 ' + visit.overdueCount + '개가 들어 있습니다';
  }
  // 여유는 '오늘'이 아니라 '그 날 가면 얼마나 아슬아슬한지'로 재야 한다
  var slack = daysBetween(visit.date, visit.earliestDeadline);
  var first = visit.items[0];
  var name = first.name + (first.dose ? ' ' + first.dose + '차' : '');
  if (slack <= 7) return name + ' 마감(' + visit.earliestDeadline + ') 직전입니다';
  if (slack <= 30) return name + ' 마감까지 ' + slack + '일 남은 시점입니다';
  return '이 날이면 ' + visit.items.length + '개 창이 한꺼번에 열려 있습니다';
}

/** 캘린더·메일에 넣을 제목 */
function visitTitle(visit, childName) {
  var names = visit.items.map(function (it) {
    return it.name.replace(/\s*\([^)]*\)\s*$/, '') + (it.dose ? ' ' + it.dose + '차' : '');
  });
  return '[' + childName + '] 소아과 — ' + names.slice(0, 3).join(', ') +
         (names.length > 3 ? ' 외 ' + (names.length - 3) + '건' : '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    planVisits: planVisits, weekdayOf: weekdayOf, weekdayLabel: weekdayLabel,
    batchDeadline_: batchDeadline_, VISIT_MAX_DELAY_DAYS: VISIT_MAX_DELAY_DAYS,
    visitDateLabel: visitDateLabel, visitSummary: visitSummary,
    visitReason: visitReason, visitTitle: visitTitle,
    VISIT_HORIZON_DAYS: VISIT_HORIZON_DAYS
  };
}
