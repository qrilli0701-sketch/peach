/**
 * 방문 묶기 검증. 이 앱의 존재 이유라 규칙을 촘촘히 못박는다.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./load');

const V = loadGs(['lib_growth.gs', 'data_schedule.gs', 'lib_schedule.gs', 'lib_visit.gs']);
const KID = { birthDate: '2026-03-21', sex: 'male' };   // 2026-09-21 에 생후 6개월

function planFor(today, done, opts) {
  const plan = V.buildFullPlan(KID, { rota: 'RV5', je: 'IJEV' }, done || {}, today);
  return V.planVisits(plan, today, opts);
}
const keysOf = v => v.items.map(i => i.key).sort();

test('6개월 아이: 한 번 가면 여러 개가 한꺼번에 끝난다', () => {
  const r = planFor('2026-09-21');
  assert.ok(r.visits.length >= 1);
  const first = r.visits[0];
  assert.ok(first.items.length >= 5,
    '첫 방문에 최소 5개는 묶여야 한다: ' + JSON.stringify(keysOf(first)));
  // 6개월에 열리는 3차들이 한 날에 모여야 한다
  for (const k of ['DTaP#3', 'Hib#3', 'PCV#3', 'RV#3']) {
    assert.ok(keysOf(first).includes(k), k + ' 가 첫 방문에 없습니다');
  }
});

test('방문일은 반드시 모든 항목의 창 안에 있다', () => {
  for (const today of ['2026-09-21', '2026-11-01', '2027-04-15', '2028-01-01']) {
    const r = planFor(today);
    for (const v of r.visits) {
      for (const it of v.items) {
        assert.ok(it.start <= v.date && v.date <= it.end,
          `${today}: ${it.key} 창(${it.start}~${it.end}) 밖에 ${v.date} 로 배정됨`);
      }
    }
  }
});

test('방문일은 오늘 이후이고, 시간순으로 정렬된다', () => {
  const today = '2026-09-21';
  const r = planFor(today);
  for (const v of r.visits) assert.ok(v.date >= today, v.date + ' 가 과거입니다');
  for (let i = 1; i < r.visits.length; i++) {
    assert.ok(r.visits[i - 1].date < r.visits[i].date, '방문이 시간순이 아닙니다');
  }
});

test('같은 항목이 두 방문에 중복 배정되지 않는다', () => {
  const r = planFor('2026-09-21');
  const all = r.visits.flatMap(keysOf);
  assert.equal(new Set(all).size, all.length, '중복: ' + all.join(','));
});

test('일요일은 피한다', () => {
  // 2026-09-21 은 월요일. 여러 시점을 훑어 일요일 배정이 나오는지 본다
  for (const today of ['2026-09-21', '2026-10-04', '2027-03-21', '2027-09-05']) {
    const r = planFor(today);
    for (const v of r.visits) {
      assert.notEqual(V.weekdayOf(v.date), 0, `${today}: ${v.date} 는 일요일입니다`);
    }
  }
});

test('일요일을 피하려다 창을 벗어나지는 않는다', () => {
  // 창이 일요일 하루뿐이면 그 날을 써야 한다
  const item = { key: 'X#1', code: 'X', name: '테스트', start: '2026-10-04', end: '2026-10-04',
                 status: 'open', dose: 1 };
  assert.equal(V.weekdayOf('2026-10-04'), 0, '전제: 2026-10-04 는 일요일');
  const r = V.planVisits([item], '2026-09-21');
  assert.equal(r.visits.length, 1);
  assert.equal(r.visits[0].date, '2026-10-04', '창이 그 날뿐이면 일요일이라도 가야 한다');
});

/* ── 생백신 4주 규칙 ─────────────────────────────────── */

test('주사용 생백신은 같은 날이거나 4주 이상 떨어진다', () => {
  // 12개월 직전 — MMR·수두·일본뇌염 생백신 창이 함께 열린다
  for (const today of ['2027-03-01', '2027-03-21', '2027-05-01']) {
    const plan = V.buildFullPlan(KID, { rota: 'RV5', je: 'LJEV' }, {}, today);
    const r = V.planVisits(plan, today);
    const liveVisits = r.visits.filter(v => v.liveCount > 0);
    for (let i = 0; i < liveVisits.length; i++) {
      for (let j = i + 1; j < liveVisits.length; j++) {
        const gap = Math.abs(V.daysBetween(liveVisits[i].date, liveVisits[j].date));
        assert.ok(gap === 0 || gap >= 28,
          `${today}: 생백신 방문 ${liveVisits[i].date} 와 ${liveVisits[j].date} 간격 ${gap}일`);
      }
    }
  }
});

test('생백신들은 가능하면 한 날에 묶인다', () => {
  const plan = V.buildFullPlan(KID, { rota: 'RV5', je: 'LJEV' }, {}, '2027-03-21');
  const r = V.planVisits(plan, '2027-03-21');
  const liveKeys = r.visits.flatMap(v => v.items.filter(i => i.live).map(i => i.key));
  assert.ok(liveKeys.length >= 2, '12개월이면 생백신이 여럿 열려 있어야 한다: ' + liveKeys);
  const liveVisitDates = new Set(
    r.visits.filter(v => v.liveCount > 0).map(v => v.date));
  assert.equal(liveVisitDates.size, 1, '생백신은 한 날에 모이는 게 최선이다');
});

/* ── 우선순위 ────────────────────────────────────────── */

test('기한이 지난 항목을 먼저 처리하는 날을 고른다', () => {
  const items = [
    { key: 'LATE#1', code: 'LATE', name: '늦은것', start: '2026-06-01', end: '2026-09-30',
      status: 'overdue', dose: 1 },
    { key: 'A#1', code: 'A', name: '나중것1', start: '2026-11-02', end: '2026-12-31', status: 'open', dose: 1 },
    { key: 'B#1', code: 'B', name: '나중것2', start: '2026-11-02', end: '2026-12-31', status: 'open', dose: 1 },
    { key: 'C#1', code: 'C', name: '나중것3', start: '2026-11-02', end: '2026-12-31', status: 'open', dose: 1 }
  ];
  const r = V.planVisits(items, '2026-09-21');
  assert.equal(r.visits[0].items[0].key, 'LATE#1', '지난 것이 먼저여야 한다');
  assert.equal(r.visits[0].overdueCount, 1);
  assert.equal(r.visits.length, 2);
  assert.equal(r.visits[1].items.length, 3, '나머지 셋은 한 날에 묶인다');
});

test('겹치는 창이 있으면 갈라놓지 않는다', () => {
  const items = [
    { key: 'A#1', code: 'A', name: 'a', start: '2026-10-01', end: '2026-10-31', status: 'open', dose: 1 },
    { key: 'B#1', code: 'B', name: 'b', start: '2026-10-15', end: '2026-11-15', status: 'open', dose: 1 },
    { key: 'C#1', code: 'C', name: 'c', start: '2026-10-20', end: '2026-12-01', status: 'open', dose: 1 }
  ];
  const r = V.planVisits(items, '2026-09-21');
  assert.equal(r.visits.length, 1, '셋 다 10/20~10/31 에 겹치므로 한 번이면 된다');
  assert.equal(r.visits[0].items.length, 3);
  assert.ok(r.visits[0].date >= '2026-10-20' && r.visits[0].date <= '2026-10-31');
});

test('계획 범위 밖은 later 로 빠진다', () => {
  const r = planFor('2026-09-21', {}, { horizonDays: 30 });
  assert.ok(r.later.length > 0, '30일 앞만 보면 나중 항목이 있어야 한다');
  for (const it of r.later) assert.ok(it.start > '2026-10-21');
  for (const v of r.visits) assert.ok(v.date <= '2026-10-21');
});

test('방문 수에 상한이 있다', () => {
  const r = planFor('2026-09-21', {}, { horizonDays: 900, maxVisits: 2 });
  assert.ok(r.visits.length <= 2);
});

test('완료·선택대기·권고 항목은 병원 방문에 들어가지 않는다', () => {
  const r = planFor('2026-09-21', { 'DTaP#3': '2026-09-22' });
  const all = r.visits.flatMap(keysOf);
  assert.ok(!all.includes('DTaP#3'), '완료한 건 빠져야 한다');
  assert.ok(!all.includes('admin#insurance'), '보험 검토는 병원 일이 아니다');
  assert.ok(!all.some(k => /choice/.test(k)), '백신 종류 선택은 항목이 아니다');
});

test('할 게 없으면 방문도 없다', () => {
  const r = V.planVisits([], '2026-09-21');
  assert.deepEqual(r.visits, []);
  assert.deepEqual(r.later, []);
});

/* ── 문구 ────────────────────────────────────────────── */

test('날짜·요약·이유 문구', () => {
  assert.equal(V.visitDateLabel('2026-10-05'), '10월 5일 (월)');
  assert.equal(V.weekdayLabel('2026-09-21'), '월');

  const v = { date: '2026-10-05', items: [{ name: '영유아 건강검진', end: '2026-10-21', dose: 2 }],
              overdueCount: 0, earliestDeadline: '2026-10-21' };
  assert.equal(V.visitSummary(v, '2026-10-05'), '오늘 가시면 1개가 끝납니다');
  assert.equal(V.visitSummary(v, '2026-10-04'), '내일 가시면 1개가 끝납니다');
  assert.equal(V.visitSummary(v, '2026-09-21'), '14일 뒤에 가시면 1개가 끝납니다');
  // '왜 이 날인지' 는 오늘이 아니라 방문일 기준으로 잰다
  assert.match(V.visitReason(v, '2026-09-21'), /영유아 건강검진 2차 마감까지 16일 남은 시점/);
  assert.match(V.visitReason({ ...v, date: '2026-10-18' }, '2026-09-21'), /마감\(2026-10-21\) 직전/);
  assert.match(V.visitReason({ ...v, overdueCount: 3 }, '2026-10-05'), /기한이 지난 3개/);
});

test('캘린더 제목은 괄호를 걷어내고 3개까지만 쓴다', () => {
  const v = { items: [
    { name: '디프테리아·파상풍·백일해 (DTaP)', dose: 3 },
    { name: 'b형 헤모필루스인플루엔자 (Hib)', dose: 3 },
    { name: '폐렴구균 (PCV, 단백결합)', dose: 3 },
    { name: '로타바이러스', dose: 3 },
    { name: '영유아 건강검진', dose: 2 }
  ]};
  const t = V.visitTitle(v, '복숭');
  assert.match(t, /^\[복숭\] 소아과 — /);
  assert.match(t, /디프테리아·파상풍·백일해 3차/);
  assert.ok(!t.includes('(DTaP)'), '괄호 약어는 빼서 짧게');
  assert.match(t, /외 2건$/);
});


/* ── 같은 백신 연속 차수 ─────────────────────────────── */

test('같은 백신의 두 차수를 한 날에 넣지 않는다', () => {
  // 독감 1차와 2차를 같은 날로 묶던 버그
  const r = planFor('2026-09-21');
  for (const v of r.visits) {
    const codes = v.items.map(i => i.code);
    assert.equal(new Set(codes).size, codes.length,
      `${v.date} 에 같은 백신이 두 번: ${codes.join(',')}`);
  }
  const flu = r.visits.flatMap(v => v.items.filter(i => i.code === 'IIV').map(i => ({ d: v.date, k: i.key })));
  if (flu.length >= 2) {
    const gap = Math.abs(V.daysBetween(flu[0].d, flu[1].d));
    assert.ok(gap >= 28, `독감 1·2차 간격이 ${gap}일입니다`);
  }
});

test('앞 차수를 배정하면 뒤 차수는 최소간격만큼 밀린다', () => {
  const items = [
    { key: 'X#1', code: 'X', name: 'x', dose: 1, start: '2026-10-01', end: '2026-12-31',
      status: 'open', minPrevD: 0 },
    { key: 'X#2', code: 'X', name: 'x', dose: 2, start: '2026-10-01', end: '2026-12-31',
      status: 'open', minPrevD: 28 }
  ];
  const r = V.planVisits(items, '2026-09-21');
  assert.equal(r.visits.length, 2, '두 차수는 서로 다른 날이어야 한다');
  const gap = V.daysBetween(r.visits[0].date, r.visits[1].date);
  assert.ok(gap >= 28, `간격이 ${gap}일입니다`);
  assert.equal(r.visits[0].items[0].dose, 1, '1차가 먼저');
  assert.equal(r.visits[1].items[0].dose, 2);
});

/* ── 묶으려고 너무 미루지 않기 ───────────────────────── */

test('창이 길어도 열린 지 6주가 넘으면 따로라도 간다', () => {
  // 방문 수만 줄이려 들면 독감 2차가 유행 정점 뒤로 밀린다
  const items = [
    { key: 'A#1', code: 'A', name: '빨리 맞아야', dose: 1,
      start: '2026-10-01', end: '2027-04-30', status: 'open' },
    { key: 'B#1', code: 'B', name: '한참 뒤에 열림', dose: 1,
      start: '2027-01-15', end: '2027-04-30', status: 'open' }
  ];
  const r = V.planVisits(items, '2026-09-21');
  assert.equal(r.visits.length, 2, '창이 겹쳐도 3개월 넘게 미루면서까지 묶지 않는다');
  assert.equal(r.visits[0].items[0].key, 'A#1');
  const delay = V.daysBetween('2026-10-01', r.visits[0].date);
  assert.ok(delay <= 42, `창이 열린 뒤 ${delay}일이나 미뤘습니다`);
});

test('상한 안에서는 여전히 묶는다', () => {
  const items = [
    { key: 'A#1', code: 'A', name: 'a', dose: 1, start: '2026-10-01', end: '2027-04-30', status: 'open' },
    { key: 'B#1', code: 'B', name: 'b', dose: 1, start: '2026-10-20', end: '2027-04-30', status: 'open' }
  ];
  const r = V.planVisits(items, '2026-09-21');
  assert.equal(r.visits.length, 1, '19일 차이면 한 번에 가는 게 낫다');
  assert.equal(r.visits[0].items.length, 2);
});

test('독감 2차가 1차 4주 뒤 근처에 잡힌다', () => {
  const r = planFor('2026-09-21');
  const flu = [];
  r.visits.forEach(v => v.items.forEach(i => { if (i.code === 'IIV') flu.push({ d: v.date, dose: i.dose }); }));
  assert.equal(flu.length, 2, '첫 해는 2회');
  const gap = V.daysBetween(flu[0].d, flu[1].d);
  assert.ok(gap >= 28, `간격 ${gap}일 — 4주 이상이어야 한다`);
  assert.ok(gap <= 70, `간격 ${gap}일 — 유행철을 넘기도록 미루면 안 된다`);
});

test('maxDelayDays 로 조절할 수 있다', () => {
  const items = [
    { key: 'A#1', code: 'A', name: 'a', dose: 1, start: '2026-10-01', end: '2027-04-30', status: 'open' },
    { key: 'B#1', code: 'B', name: 'b', dose: 1, start: '2026-11-20', end: '2027-04-30', status: 'open' }
  ];
  assert.equal(V.planVisits(items, '2026-09-21', { maxDelayDays: 14 }).visits.length, 2);
  assert.equal(V.planVisits(items, '2026-09-21', { maxDelayDays: 120 }).visits.length, 1);
});
