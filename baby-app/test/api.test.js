/**
 * 통합 테스트 — 가짜 Apps Script 런타임 위에서 Api.gs 를 실제로 호출한다.
 * 시트 생성 → 아이 등록 → 성장 기록 → 접종 완료 → 생활기록 까지 한 바퀴.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeEnv } = require('./appsscript.mock');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['data_lms.gs', 'data_schedule.gs', 'lib_growth.gs', 'lib_schedule.gs',
               'Setup.gs', 'Store.gs', 'Code.gs', 'Api.gs', 'Triggers.gs'];

function boot(opts) {
  const env = makeEnv(opts);
  const sandbox = Object.assign({ console, Math, JSON, isFinite, isNaN, parseInt, parseFloat,
                                  Infinity, NaN, String, Number, Object, Array, Error, RegExp }, env);
  vm.createContext(sandbox);
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
  }
  vm.runInContext("SPREADSHEET_ID = 'test-sheet';", sandbox);
  vm.runInContext('setupSheets();', sandbox);
  sandbox._env = env;
  return sandbox;
}

/** api() 호출. 실패하면 에러 메시지째로 던져 테스트에서 바로 보이게 한다. */
function api(S, action, payload) {
  const r = S.api(action, payload || {});
  if (!r.ok) throw new Error(`${action}: ${r.error}`);
  return r.data;
}

test('setupSheets 가 모든 탭을 만든다', () => {
  const S = boot({ now: '2026-03-01' });
  const names = Object.keys(S._env._sheets);
  for (const n of ['설정', '아이', '성장기록', '일정완료', '할일', '생활기록', '병원']) {
    assert.ok(names.includes(n), `${n} 탭 없음`);
  }
  // 재실행해도 깨지지 않는다
  assert.doesNotThrow(() => vm.runInContext('setupSheets();', S));
});

test('허용되지 않은 계정은 막힌다', () => {
  const S = boot({ now: '2026-03-01', email: 'papa@example.com' });
  // seedSettings_ 가 현재 사용자를 허용이메일에 넣었으므로 통과해야 한다
  assert.ok(S.api('bootstrap', {}).ok);

  const T = boot({ now: '2026-03-01', email: 'stranger@example.com' });
  vm.runInContext("updateRow('설정','키','허용이메일',{'값':'papa@example.com'});", T);
  const r = T.api('bootstrap', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /접근 권한이 없습니다/);
});

test('전체 흐름: 아이 등록 → 성장 → 일정 → 기록', () => {
  const S = boot({ now: '2026-03-01' });

  // 아이 등록
  const { id } = api(S, 'childSave', { name: '복숭', birthDate: '2025-01-01', sexLabel: '남' });
  assert.ok(id);
  const boot1 = api(S, 'bootstrap');
  assert.equal(boot1.children.length, 1);
  assert.equal(boot1.children[0].name, '복숭');

  // 잘못된 입력은 거부
  assert.throws(() => api(S, 'childSave', { name: '', birthDate: '2025-01-01' }), /이름/);
  assert.throws(() => api(S, 'childSave', { name: 'x', birthDate: '2025/01/01' }), /yyyy-MM-dd/);
  assert.throws(() => api(S, 'childSave', { name: 'x', birthDate: '2030-01-01' }), /미래/);

  // 성장 기록 3건
  api(S, 'growthAdd', { childId: id, date: '2025-07-01', heightCm: 67.6, weightKg: 8.0, headCm: 43.5 });
  api(S, 'growthAdd', { childId: id, date: '2025-11-01', heightCm: 74.0, weightKg: 9.2 });
  const added = api(S, 'growthAdd', { childId: id, date: '2026-02-01', heightCm: 78.5, weightKg: 10.2 });
  assert.ok(added.evaluated.metrics.wfa.percentile > 0);

  const g = api(S, 'growth', { childId: id });
  assert.equal(g.rows.length, 3);
  assert.ok(g.rows[0].metrics.wfa.text.endsWith('p'));
  assert.ok(g.rows[2].ageLabel.length > 0);
  assert.ok(g.trends.wfa, '추세가 계산되어야 한다');

  // 이상값은 거부
  assert.throws(() => api(S, 'growthAdd', { childId: id, date: '2026-02-02', weightKg: 400 }), /몸무게/);
  assert.throws(() => api(S, 'growthAdd', { childId: id, date: '2024-01-01', weightKg: 5 }), /생년월일/);
  assert.throws(() => api(S, 'growthAdd', { childId: id, date: '2026-02-02' }), /하나는 입력/);

  // 그래프 데이터
  const ch = api(S, 'growthChart', { childId: id, indicator: 'wfa' });
  assert.equal(ch.bands.length, 5);
  assert.equal(ch.points.length, 3);
  assert.ok(ch.bands[0].points.length > 10);
  for (const b of ch.bands) assert.ok(b.points.every(p => isFinite(p.y) && p.y > 0));

  // 일정
  const sch = api(S, 'schedule', { childId: id });
  assert.ok(sch.items.length > 20);
  const bcg = sch.items.find(x => x.key === 'BCG#1');
  assert.equal(bcg.status, 'overdue', '2026년 3월이면 BCG 창은 한참 지났다');

  // 완료 체크 → 상태가 바뀐다
  api(S, 'scheduleDone', { childId: id, key: 'BCG#1', date: '2025-01-05', place: 'OO산부인과' });
  const sch2 = api(S, 'schedule', { childId: id });
  assert.equal(sch2.items.find(x => x.key === 'BCG#1').doneDate, '2025-01-05');
  assert.equal(sch2.items.find(x => x.key === 'BCG#1').status, 'done');

  // 같은 항목을 두 번 체크해도 행이 늘지 않는다
  api(S, 'scheduleDone', { childId: id, key: 'BCG#1', date: '2025-01-06' });
  const doneRows = vm.runInContext("readTable('일정완료').length", S);
  assert.equal(doneRows, 1);
  assert.equal(api(S, 'schedule', { childId: id }).items.find(x => x.key === 'BCG#1').doneDate, '2025-01-06');

  // 취소
  api(S, 'scheduleUndone', { childId: id, key: 'BCG#1' });
  assert.equal(api(S, 'schedule', { childId: id }).items.find(x => x.key === 'BCG#1').doneDate, null);

  // 백신 종류 선택
  assert.ok(api(S, 'schedule', { childId: id }).items.some(x => x.code === 'RV' && x.needsChoice));
  api(S, 'vaccineChoice', { childId: id, series: 'rota', choice: 'RV5' });
  const rv = api(S, 'schedule', { childId: id }).items.filter(x => x.code === 'RV');
  assert.equal(rv.length, 3);
  assert.throws(() => api(S, 'vaccineChoice', { childId: id, series: 'rota', choice: '아무거나' }),
                /알 수 없는 백신 종류/);

  // 생활기록
  api(S, 'logAdd', { childId: id, type: '수유', v1: '160ml 분유', at: '2026-03-01 13:20' });
  api(S, 'logAdd', { childId: id, type: '수면', v1: '13:40', v2: '15:10', at: '2026-03-01 15:10' });
  api(S, 'logAdd', { childId: id, type: '배변', v1: '보통', at: '2026-03-01 09:00' });
  api(S, 'logAdd', { childId: id, type: '체온', v1: '36.8', at: '2026-03-01 18:00' });
  api(S, 'logAdd', { childId: id, type: '메모', detail: '낮잠 짧았음', at: '2026-03-01 19:00' });

  const logs = api(S, 'logs', { childId: id, days: 2 });
  assert.equal(logs.rows.length, 5);
  assert.equal(logs.rows[0].at, '2026-03-01 19:00', '최신순 정렬');
  assert.equal(logs.summary.poopCount, 1);
  assert.equal(logs.summary.sleepMinutes, 90);
  assert.equal(logs.summary.lastFeed.detail, '160ml 분유');
  assert.equal(logs.summary.lastTemp.value, '36.8');
  assert.equal(logs.summary.memo, '낮잠 짧았음');

  // 홈 화면
  const d = api(S, 'dashboard', { childId: id });
  assert.equal(d.child.name, '복숭');
  assert.equal(d.child.ageMonths, 14);
  assert.ok(d.growth.metrics.wfa.value === 10.2);
  assert.equal(d.growth.metrics.wfa.unit, 'kg');
  assert.ok(d.overdue.length > 0);
  assert.equal(d.todaySummary.entryCount, 5);

  // 할일
  const t = api(S, 'todoAdd', { childId: id, title: '어린이집 서류', due: '2026-03-10', owner: '아빠' });
  assert.equal(api(S, 'dashboard', { childId: id }).todos.length, 1);
  api(S, 'todoDone', { id: t.id });
  assert.equal(api(S, 'dashboard', { childId: id }).todos.length, 0);

  // 병원
  api(S, 'clinicAdd', { childId: id, date: '2026-02-20', place: 'OO소아과',
                        symptom: '기침', diagnosis: '감기', prescription: '시럽', cost: 12000 });
  const cl = api(S, 'clinics', { childId: id });
  assert.equal(cl.rows.length, 1);
  assert.equal(cl.rows[0].diagnosis, '감기');

  // 응급 카드
  const card = api(S, 'emergencyCard', { childId: id });
  assert.equal(card.name, '복숭');
  assert.equal(card.weightKg, 10.2);
});

test('둘째를 추가해도 데이터가 섞이지 않는다', () => {
  const S = boot({ now: '2026-03-01' });
  const a = api(S, 'childSave', { name: '첫째', birthDate: '2023-05-05', sexLabel: '여' }).id;
  const b = api(S, 'childSave', { name: '둘째', birthDate: '2025-09-09', sexLabel: '남' }).id;
  assert.notEqual(a, b);

  api(S, 'growthAdd', { childId: a, date: '2026-01-01', weightKg: 14 });
  api(S, 'growthAdd', { childId: b, date: '2026-01-01', weightKg: 7.5 });
  api(S, 'logAdd', { childId: a, type: '배변', v1: '보통' });

  assert.equal(api(S, 'growth', { childId: a }).rows.length, 1);
  assert.equal(api(S, 'growth', { childId: b }).rows.length, 1);
  assert.equal(api(S, 'growth', { childId: a }).rows[0].weightKg, 14);
  assert.equal(api(S, 'logs', { childId: b, days: 2 }).rows.length, 0);

  // 같은 항목키라도 아이별로 따로 관리된다
  api(S, 'scheduleDone', { childId: a, key: 'MMR#1', date: '2024-05-20' });
  assert.equal(api(S, 'schedule', { childId: a }).items.find(x => x.key === 'MMR#1').doneDate, '2024-05-20');
  assert.equal(api(S, 'schedule', { childId: b }).items.find(x => x.key === 'MMR#1').doneDate, null);
});

test('접종을 늦게 하면 다음 차수가 밀려서 내려온다', () => {
  const S = boot({ now: '2025-06-01' });
  const id = api(S, 'childSave', { name: '복숭', birthDate: '2025-01-01', sexLabel: '남' }).id;
  api(S, 'scheduleDone', { childId: id, key: 'DTaP#1', date: '2025-05-20' });   // 2개월 표준인데 4.5개월에 맞음
  const d2 = api(S, 'schedule', { childId: id }).items.find(x => x.key === 'DTaP#2');
  assert.equal(d2.start, '2025-06-17', '실제 접종일 + 28일');
  assert.equal(d2.shifted, true);
});

test('알 수 없는 액션과 없는 아이는 오류로 돌아온다', () => {
  const S = boot({ now: '2026-03-01' });
  let r = S.api('없는액션', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /알 수 없는 요청/);

  r = S.api('dashboard', { childId: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /찾을 수 없습니다/);
});

test('checkSetup 이 상태를 요약한다', () => {
  const S = boot({ now: '2026-03-01' });
  api(S, 'childSave', { name: '복숭', birthDate: '2025-01-01', sexLabel: '남' });
  const out = vm.runInContext('checkSetup();', S);
  assert.match(out, /아이 \(1행\)/);
  assert.match(out, /허용이메일/);
});

/* ── 회귀 ───────────────────────────────────────────── */

test('회귀: 백신 종류를 안 고른 상태에서도 일정/홈이 열린다', () => {
  // needsChoice 항목에는 날짜 창이 없어서 D-day 계산이 터졌던 버그
  const S = boot({ now: '2026-03-01' });
  const id = api(S, 'childSave', { name: '복숭', birthDate: '2025-01-01', sexLabel: '남' }).id;

  const sch = api(S, 'schedule', { childId: id });
  const choice = sch.items.filter(x => x.needsChoice);
  assert.equal(choice.length, 2, '로타·일본뇌염 둘 다 선택 대기여야 한다');
  for (const c of choice) {
    assert.equal(c.dday, '');
    assert.equal(c.alert, false);
    assert.ok(Array.isArray(c.choices) && c.choices.length === 2);
  }
  assert.doesNotThrow(() => api(S, 'dashboard', { childId: id }));
  const d = api(S, 'dashboard', { childId: id });
  assert.ok(d.open.some(x => x.needsChoice), '홈의 "지금 가능"에 선택 카드가 보여야 한다');
});

/* ── 주간 메일 / 캘린더 ─────────────────────────────── */

test('주간 요약 메일이 밀린 항목을 담아 나간다', () => {
  const S = boot({ now: '2026-03-01' });
  const id = api(S, 'childSave', { name: '복숭', birthDate: '2025-01-01', sexLabel: '남' }).id;
  vm.runInContext('weeklyDigest();', S);

  assert.equal(S._env.sentMail.length, 1);
  const mail = S._env.sentMail[0];
  assert.equal(mail.to, 'papa@example.com');
  assert.match(mail.subject, /2026-03-01/);
  assert.match(mail.htmlBody, /복숭/);
  assert.match(mail.htmlBody, /생후 14개월/);
  assert.match(mail.htmlBody, /지났습니다/);
  assert.match(mail.htmlBody, /nip\.kdca\.go\.kr/, '참고용 안내가 들어가야 한다');
  assert.match(mail.htmlBody, /script\.google\.com/, '앱 링크');
});

test('주간 메일: 아이가 없으면 보내지 않는다', () => {
  const S = boot({ now: '2026-03-01' });
  vm.runInContext('weeklyDigest();', S);
  assert.equal(S._env.sentMail.length, 0);
});

test('주간 메일: 이름에 들어간 HTML 이 이스케이프된다', () => {
  const S = boot({ now: '2026-03-01' });
  api(S, 'childSave', { name: '<script>x</script>', birthDate: '2025-01-01', sexLabel: '남' });
  vm.runInContext('weeklyDigest();', S);
  const body = S._env.sentMail[0].htmlBody;
  assert.ok(!body.includes('<script>x</script>'));
  assert.match(body, /&lt;script&gt;/);
});

test('캘린더 동기화: 임박한 항목만 넣는다', () => {
  const S = boot({ now: '2026-03-01' });
  const id = api(S, 'childSave', { name: '복숭', birthDate: '2025-01-01', sexLabel: '남' }).id;
  vm.runInContext('syncCalendar();', S);

  const evs = S._env.calendarEvents.filter(e => !e._deleted);
  assert.ok(evs.length > 0);
  for (const e of evs) {
    assert.match(e._title, /^\[복숭\]/);
    assert.equal(e.getTag('babyapp'), '1');
    assert.match(e._opts.description, /창: \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/);
  }
  // 두 번 돌려도 중복되지 않는다 (앞선 것을 지우고 다시 만든다)
  const before = evs.length;
  vm.runInContext('syncCalendar();', S);
  assert.equal(S._env.calendarEvents.filter(e => !e._deleted).length, before);
});
