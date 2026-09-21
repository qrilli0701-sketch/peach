const test = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./load');

const S = loadGs(['lib_growth.gs', 'data_schedule.gs', 'lib_schedule.gs']);
const CHILD = { birthDate: '2025-01-01', sex: 'male' };
const find = (plan, key) => plan.find(x => x.key === key);

/* ── 창 계산 ─────────────────────────────────────────────── */

test('BCG 는 생후 4주 이내', () => {
  const p = S.buildVaccinePlan(CHILD, {}, {}, '2025-01-10');
  const bcg = find(p, 'BCG#1');
  assert.equal(bcg.start, '2025-01-01');
  assert.equal(bcg.end, '2025-01-29');   // +28일
  assert.equal(bcg.status, S.ST_OPEN);
});

test('B형간염 3회 창', () => {
  const p = S.buildVaccinePlan(CHILD, {}, {}, '2025-01-10');
  assert.deepEqual([find(p,'HepB#1').start, find(p,'HepB#1').end], ['2025-01-01', '2025-01-08']);
  assert.deepEqual([find(p,'HepB#2').start, find(p,'HepB#2').end], ['2025-02-01', '2025-03-01']);
  assert.deepEqual([find(p,'HepB#3').start, find(p,'HepB#3').end], ['2025-07-01', '2025-09-01']);
});

test('DTaP 표준 5회 창', () => {
  const p = S.buildVaccinePlan(CHILD, {}, {}, '2025-01-10');
  const d = n => find(p, 'DTaP#' + n);
  assert.equal(d(1).start, '2025-03-01');   // 2개월
  assert.equal(d(2).start, '2025-05-01');   // 4개월
  assert.equal(d(3).start, '2025-07-01');   // 6개월
  assert.equal(d(4).start, '2026-04-01');   // 15개월
  assert.equal(d(4).end,   '2026-07-01');   // 18개월
  assert.equal(d(5).start, '2029-01-01');   // 만 4세
  assert.equal(d(5).end,   '2031-01-01');   // 만 6세
  assert.equal(d(1).totalDoses, 5);
});

/* ── 지연 시 재계산 (이 앱의 핵심) ──────────────────────── */

test('앞 차수가 늦으면 다음 차수 창이 밀린다', () => {
  // 1차를 4개월에 맞음 (2개월 표준보다 2개월 늦음)
  const done = { 'DTaP#1': '2025-05-01' };
  const p = S.buildVaccinePlan(CHILD, {}, done, '2025-05-10');
  const d2 = find(p, 'DTaP#2');
  assert.equal(d2.start, '2025-05-29', '실제 접종일 + 최소간격 28일');
  assert.equal(d2.shifted, true);
  assert.equal(find(p, 'DTaP#1').status, S.ST_DONE);
});

test('앞 차수가 표준대로면 창이 밀리지 않는다', () => {
  const done = { 'DTaP#1': '2025-03-05' };
  const p = S.buildVaccinePlan(CHILD, {}, done, '2025-03-10');
  const d2 = find(p, 'DTaP#2');
  assert.equal(d2.start, '2025-05-01', '표준 4개월이 최소간격보다 늦으므로 그대로');
  assert.equal(d2.shifted, false);
});

test('앞 차수 기록이 없으면 표준일정을 유지한다', () => {
  const p = S.buildVaccinePlan(CHILD, {}, { 'DTaP#2': '2025-05-10' }, '2025-06-01');
  assert.equal(find(p, 'DTaP#1').start, '2025-03-01');
  assert.equal(find(p, 'DTaP#3').start, '2025-07-01');  // 2차 실제일+28=6/7 보다 늦음
});

test('A형간염 2차는 1차 후 6개월', () => {
  const p = S.buildVaccinePlan(CHILD, {}, { 'HepA#1': '2026-03-01' }, '2026-03-05');
  assert.equal(find(p, 'HepA#2').start, '2026-08-28');  // +180일
  assert.equal(find(p, 'HepA#2').shifted, true);
});

/* ── 백신 종류 선택 ──────────────────────────────────────── */

test('로타·일본뇌염은 종류를 고르기 전엔 선택 항목만 나온다', () => {
  const p = S.buildVaccinePlan(CHILD, {}, {}, '2025-03-01');
  const rota = p.filter(x => x.code === 'RV');
  assert.equal(rota.length, 1);
  assert.equal(rota[0].needsChoice, true);
  assert.deepEqual(rota[0].choices.map(c => c.key), ['RV1', 'RV5']);
  assert.equal(p.filter(x => x.code === 'JE')[0].needsChoice, true);
});

test('로타릭스 2회 / 로타텍 3회', () => {
  const a = S.buildVaccinePlan(CHILD, { rota: 'RV1' }, {}, '2025-03-01').filter(x => x.code === 'RV');
  const b = S.buildVaccinePlan(CHILD, { rota: 'RV5' }, {}, '2025-03-01').filter(x => x.code === 'RV');
  assert.equal(a.length, 2);
  assert.equal(b.length, 3);
  assert.match(a[0].variant, /로타릭스/);
  assert.match(b[0].variant, /로타텍/);
});

test('일본뇌염 불활성화 5회 / 생백신 2회', () => {
  const i = S.buildVaccinePlan(CHILD, { je: 'IJEV' }, {}, '2026-01-01').filter(x => x.code === 'JE');
  const l = S.buildVaccinePlan(CHILD, { je: 'LJEV' }, {}, '2026-01-01').filter(x => x.code === 'JE');
  assert.equal(i.length, 5);
  assert.equal(l.length, 2);
  assert.equal(i[3].start, '2031-01-01');  // 만 6세
  assert.equal(i[4].start, '2037-01-01');  // 만 12세
});

/* ── 건강검진 ────────────────────────────────────────────── */

test('영유아 건강검진 8차 + 구강 4회', () => {
  const p = S.buildCheckupPlan(CHILD, {}, '2025-02-01');
  assert.equal(p.filter(x => x.code === '영유아').length, 8);
  assert.equal(p.filter(x => x.code === '구강').length, 4);
});

test('1차 검진은 생후 14~35일', () => {
  const c = find(S.buildCheckupPlan(CHILD, {}, '2025-01-20'), '영유아#1');
  assert.equal(c.start, '2025-01-15');
  assert.equal(c.end, '2025-02-05');
  assert.equal(c.status, S.ST_OPEN);
});

test('2차 검진은 4개월 0일 ~ 6개월 30일', () => {
  const c = find(S.buildCheckupPlan(CHILD, {}, '2025-05-01'), '영유아#2');
  assert.equal(c.start, '2025-05-01');
  assert.equal(c.end, '2025-07-31');   // 6개월(7/1) + 30일
});

test('8차 검진은 66~71개월', () => {
  const c = find(S.buildCheckupPlan(CHILD, {}, '2030-01-01'), '영유아#8');
  assert.equal(c.start, '2030-07-01');   // 66개월 = 5년 6개월
  assert.equal(c.end, '2030-12-31');     // 71개월(2030-12-01) + 30일
});

/* ── 상태 판정 ───────────────────────────────────────────── */

test('windowStatus 전이', () => {
  const [s, e] = ['2025-06-01', '2025-07-01'];
  assert.equal(S.windowStatus(s, e, '2025-03-01', null), S.ST_FUTURE);
  assert.equal(S.windowStatus(s, e, '2025-05-20', null), S.ST_SOON);
  assert.equal(S.windowStatus(s, e, '2025-06-01', null), S.ST_OPEN);
  assert.equal(S.windowStatus(s, e, '2025-07-01', null), S.ST_OPEN);
  assert.equal(S.windowStatus(s, e, '2025-07-02', null), S.ST_OVERDUE);
  assert.equal(S.windowStatus(s, e, '2025-09-01', '2025-06-15'), S.ST_DONE);
});

test('planDigest: 지남/지금/곧 으로 나눈다', () => {
  const plan = S.buildFullPlan(CHILD, { rota: 'RV1', je: 'IJEV' }, {}, '2025-06-01');
  const g = S.planDigest(plan, '2025-06-01', 60);
  assert.ok(g.overdue.length > 0, 'BCG·HepB·1차검진은 이미 지났어야 한다');
  assert.ok(g.overdue.some(x => x.key === 'BCG#1'));
  assert.ok(g.open.some(x => x.key === 'DTaP#2'), '4개월 시점이면 2차가 열려 있어야');
  // 정렬: 마감 빠른 순
  for (let i = 1; i < g.overdue.length; i++) assert.ok(g.overdue[i - 1].end <= g.overdue[i].end);
  for (let i = 1; i < g.soon.length; i++) assert.ok(g.soon[i - 1].start <= g.soon[i].start);
});

test('dDayText', () => {
  const item = { start: '2025-06-01', end: '2025-07-01', doneDate: null };
  assert.equal(S.dDayText(item, '2025-06-20'), 'D-11');
  assert.equal(S.dDayText(item, '2025-07-01'), '오늘 마감');
  assert.equal(S.dDayText(item, '2025-07-05'), 'D+4 지남');
  assert.equal(S.dDayText({ ...item, doneDate: '2025-06-10' }, '2025-07-05'), '완료 2025-06-10');
});

test('needsAlert: 무료 검진 마감 3주 전부터 경고', () => {
  const item = { start: '2025-06-01', end: '2025-07-01', doneDate: null, status: S.ST_OPEN };
  assert.equal(S.needsAlert(item, '2025-06-05'), false);
  assert.equal(S.needsAlert(item, '2025-06-15'), true);
  assert.equal(S.needsAlert({ ...item, status: S.ST_OVERDUE }, '2025-08-01'), true);
  assert.equal(S.needsAlert({ ...item, doneDate: '2025-06-10' }, '2025-06-15'), false);
});

/* ── 달 말일 경계 ───────────────────────────────────────── */

test('1월 31일생도 창이 어긋나지 않는다', () => {
  const kid = { birthDate: '2025-01-31' };
  const p = S.buildVaccinePlan(kid, {}, {}, '2025-02-01');
  assert.equal(find(p, 'DTaP#1').start, '2025-03-31');
  assert.equal(find(p, 'HepB#2').start, '2025-02-28');  // 2월엔 31일이 없음
  assert.equal(find(p, 'HepB#2').end, '2025-03-31');
});

test('행정 일정: 출생신고·아동수당 기한', () => {
  const p = S.buildAdminPlan(CHILD, {}, '2025-01-10');
  assert.equal(find(p, 'admin#birth-report').end, '2025-01-31');
  assert.equal(find(p, 'admin#child-allowance').end, '2025-03-02');
  assert.equal(find(p, 'admin#birth-report').status, S.ST_OPEN);
});

test('전체 계획에 중복 key 가 없다', () => {
  const plan = S.buildFullPlan(CHILD, { rota: 'RV5', je: 'LJEV' }, {}, '2025-06-01');
  const keys = plan.filter(x => x.key).map(x => x.key);
  assert.equal(new Set(keys).size, keys.length);
});

/* ── 인플루엔자 (시즌 반복) ──────────────────────────── */

const FLU_KID = { birthDate: '2026-03-21', sex: 'male' };   // 생후 6개월 = 2026-09-21

test('독감: 생애 첫 접종은 4주 간격 2회', () => {
  const p = S.buildFluPlan(FLU_KID, {}, '2026-09-21');
  const cur = p.filter(x => x.name.indexOf('2026-2027') >= 0);
  assert.equal(cur.length, 2);
  assert.equal(cur[0].start, '2026-09-21', '생후 6개월이 시즌 시작보다 늦으면 그날부터');
  assert.equal(cur[0].end, '2027-04-30');
  assert.equal(cur[1].start, '2026-10-19');           // +28일
  assert.match(cur[0].note, /생애 첫 접종/);
});

test('독감: 생후 6개월 전이면 그 시즌에 안 나온다', () => {
  const baby = { birthDate: '2026-08-01' };            // 6개월 = 2027-02-01
  const p = S.buildFluPlan(baby, {}, '2026-09-21');
  const cur = p.filter(x => x.name.indexOf('2026-2027') >= 0);
  assert.equal(cur[0].start, '2027-02-01', '시즌 중간이라도 생후 6개월부터');
});

test('독감: 1차를 맞아도 2차가 사라지지 않는다', () => {
  // 같은 시즌 1차를 '생애 첫 접종 있음'으로 세어 2차가 없어지던 버그
  const p = S.buildFluPlan(FLU_KID, { 'IIV#2026-1': '2026-10-05' }, '2026-10-20');
  const cur = p.filter(x => x.name.indexOf('2026-2027') >= 0);
  assert.equal(cur.length, 2);
  assert.equal(cur[0].doneDate, '2026-10-05');
  assert.equal(cur[1].start, '2026-11-02', '1차 실제 접종일 + 28일');
});

test('독감: 1차가 늦으면 2차도 밀린다', () => {
  const p = S.buildFluPlan(FLU_KID, { 'IIV#2026-1': '2026-12-10' }, '2026-12-20');
  const d2 = p.filter(x => x.name.indexOf('2026-2027') >= 0)[1];
  assert.equal(d2.start, '2027-01-07');
});

test('독감: 지난 시즌에 맞았으면 다음부터는 1회', () => {
  const done = { 'IIV#2026-1': '2026-10-05', 'IIV#2026-2': '2026-11-02' };
  const p = S.buildFluPlan(FLU_KID, done, '2027-10-01');
  const cur = p.filter(x => x.name.indexOf('2027-2028') >= 0);
  assert.equal(cur.length, 1);
  assert.equal(cur[0].totalDoses, 1);
  assert.match(cur[0].note, /매 시즌 1회/);
});

test('독감: 이미 끝난 시즌은 내보내지 않는다', () => {
  const p = S.buildFluPlan(FLU_KID, {}, '2027-06-01');   // 2026-2027 시즌은 4/30 로 끝남
  assert.equal(p.filter(x => x.name.indexOf('2026-2027') >= 0).length, 0);
  assert.ok(p.filter(x => x.name.indexOf('2027-2028') >= 0).length > 0);
});

test('독감: 1~4월은 작년 시즌으로 친다', () => {
  const p = S.buildFluPlan(FLU_KID, {}, '2027-02-15');
  assert.ok(p.some(x => x.name.indexOf('2026-2027') >= 0), '2월이면 아직 이번 시즌');
});

/* ── 이름·권고 항목 ─────────────────────────────────── */

test('검진 이름에 "차"가 중복되지 않는다', () => {
  const p = S.buildCheckupPlan(CHILD, {}, '2025-06-01');
  const c1 = find(p, '영유아#1');
  assert.equal(c1.name, '영유아 건강검진');      // 화면에서 dose 로 "1/8차" 를 따로 붙인다
  assert.equal(c1.dose, 1);
  assert.equal(c1.totalDoses, 8);
  assert.equal(find(p, '구강#2').name, '영유아 구강검진');
  assert.equal(find(p, '구강#2').totalDoses, 4);
  for (const it of p) assert.ok(!/차.*차/.test(it.name), it.name);
});

test('권고 항목(보험)은 기한이 지나도 빨갛게 뜨지 않는다', () => {
  const p = S.buildAdminPlan(CHILD, {}, '2026-06-01');    // 1년 넘게 지난 시점
  const ins = find(p, 'admin#insurance');
  assert.equal(ins.status, S.ST_OPEN, '권고는 overdue 로 몰지 않는다');
  assert.equal(ins.advisory, true);
  assert.equal(S.needsAlert(ins, '2026-06-01'), false);
  assert.equal(S.dDayText(ins, '2026-06-01'), '기한 없음');

  // 진짜 기한이 있는 것은 여전히 지남으로 뜬다
  assert.equal(find(p, 'admin#birth-report').status, S.ST_OVERDUE);
});
