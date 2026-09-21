const test = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./load');

const G = loadGs(['data_lms.gs', 'lib_growth.gs']);

/* ── 1. 정규분포 함수 ─────────────────────────────────────── */

test('normalCdf: 알려진 값과 일치', () => {
  const cases = [[0, 0.5], [1, 0.8413447461], [-1, 0.1586552539],
                 [1.959963985, 0.975], [-2.575829304, 0.005], [3, 0.9986501020]];
  for (const [z, expected] of cases) {
    assert.ok(Math.abs(G.normalCdf(z) - expected) < 1e-9,
      `Φ(${z}) = ${G.normalCdf(z)}, 기대 ${expected}`);
  }
});

test('normalInv: normalCdf 의 역함수', () => {
  for (let p = 0.001; p < 0.999; p += 0.0007) {
    const z = G.normalInv(p);
    assert.ok(Math.abs(G.normalCdf(z) - p) < 1e-12, `p=${p} 왕복 실패`);
  }
});

/* ── 2. WHO 공표값 직접 확인 ──────────────────────────────── */
/* 출처: WHO Child Growth Standards 중앙값(50th percentile) 표 */

test('WHO 공표 중앙값과 일치 (출생 시)', () => {
  // 남아 출생 체중 중앙값 3.3kg, 신장 49.9cm / 여아 3.2kg, 49.1cm
  const checks = [
    ['wfa', 'male', 0, 3.3, 0.15], ['lhfa', 'male', 0, 49.9, 0.15],
    ['wfa', 'female', 0, 3.2, 0.15], ['lhfa', 'female', 0, 49.1, 0.15],
  ];
  for (const [ind, sex, days, published, tol] of checks) {
    const median = G.lmsAt(ind, sex, days).M;
    assert.ok(Math.abs(median - published) < tol,
      `${ind}/${sex} @${days}일 중앙값 ${median.toFixed(3)}, WHO 공표 ${published}`);
  }
});

test('중앙값을 넣으면 z≈0, 백분위≈50', () => {
  for (const ind of ['wfa', 'lhfa', 'hcfa', 'bfa']) {
    for (const sex of ['male', 'female']) {
      for (const days of [0, 30, 100, 365, 730, 1000, 1856]) {
        const M = G.lmsAt(ind, sex, days).M;
        const r = G.growthEvaluate(ind, sex, M, days);
        assert.ok(Math.abs(r.zScore) < 1e-12, `${ind}/${sex}@${days} z=${r.zScore}`);
        assert.ok(Math.abs(r.percentile - 50) < 1e-9);
      }
    }
  }
});

test('z ↔ 값 왕복', () => {
  for (const ind of ['wfa', 'lhfa', 'hcfa', 'bfa']) {
    for (const days of [0, 200, 900, 1856]) {
      const p = G.lmsAt(ind, 'female', days);
      for (const z of [-3, -1.5, 0, 1.5, 3]) {
        const v = G.valueFromZ(z, p.L, p.M, p.S);
        assert.ok(Math.abs(G.zFromLms(v, p.L, p.M, p.S) - z) < 1e-9);
      }
    }
  }
});

test('백분위 밴드는 단조 증가', () => {
  for (const days of [0, 90, 365, 1200]) {
    let prev = -Infinity;
    for (const p of [0.1, 3, 15, 50, 85, 97, 99.9]) {
      const v = G.growthValueAtPercentile('wfa', 'male', p, days);
      assert.ok(v > prev, `${days}일 ${p}p=${v} 가 직전 ${prev} 이하`);
      prev = v;
    }
  }
});

test('범위를 벗어나면 clamped 표시', () => {
  assert.equal(G.lmsAt('wfa', 'male', 5000).clamped, true);
  assert.equal(G.lmsAt('wfa', 'male', -10).clamped, true);
  assert.equal(G.lmsAt('wfa', 'male', 500).clamped, false);
});

/* ── 3. 날짜 계산 ─────────────────────────────────────────── */

test('daysBetween / addDays / addMonths', () => {
  assert.equal(G.daysBetween('2025-01-01', '2025-01-31'), 30);
  assert.equal(G.daysBetween('2024-02-28', '2024-03-01'), 2);      // 윤년
  assert.equal(G.daysBetween('2025-02-28', '2025-03-01'), 1);
  assert.equal(G.daysBetween('2025-03-30', '2025-03-30'), 0);
  assert.equal(G.addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(G.addMonths('2025-01-31', 1), '2025-02-28');        // 말일 보정
  assert.equal(G.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(G.addMonths('2025-11-15', 3), '2026-02-15');
  assert.equal(G.addMonths('2025-06-15', -1), '2025-05-15');
});

test('서머타임/타임존 경계에서도 일수가 어긋나지 않음', () => {
  // 한국은 DST 가 없지만 스크립트가 다른 타임존에서 돌 수 있다. UTC 정오 기준이라 안전.
  assert.equal(G.daysBetween('2025-03-09', '2025-03-10'), 1);
  assert.equal(G.daysBetween('2025-11-02', '2025-11-03'), 1);
  let d = '2020-01-01';
  for (let i = 0; i < 2000; i++) d = G.addDays(d, 1);
  assert.equal(G.daysBetween('2020-01-01', d), 2000);
});

test('ageLabel / ageMonths', () => {
  assert.equal(G.ageLabel('2025-01-01', '2025-01-15'), '생후 14일');
  assert.equal(G.ageLabel('2025-01-01', '2025-03-04'), '생후 2개월 3일');
  assert.equal(G.ageLabel('2023-01-01', '2025-06-10'), '2세 5개월');
  assert.equal(G.ageMonths('2025-01-01', '2025-12-31'), 11);
  assert.equal(G.ageMonths('2025-01-01', '2026-01-01'), 12);
  assert.equal(G.ageMonths('2025-01-31', '2025-02-28'), 1);        // 말일 보정 반영
});

/* ── 4. 기록 평가 ─────────────────────────────────────────── */

test('evaluateRecord: 전 지표 산출', () => {
  const child = { birthDate: '2025-01-01', sex: 'male' };
  const r = G.evaluateRecord(child, { date: '2026-03-01', heightCm: 78.5, weightKg: 10.2, headCm: 47.1 });
  assert.equal(r.ageDays, 424);
  assert.ok(r.metrics.lhfa && r.metrics.wfa && r.metrics.hcfa && r.metrics.bfa);
  assert.ok(r.metrics.wfl, '24개월 미만은 체중-신장(누운키) 표를 써야 한다');
  assert.ok(!r.metrics.wfh);
  assert.ok(Math.abs(r.bmi - 10.2 / 0.785 ** 2) < 1e-9);
  for (const k of Object.keys(r.metrics)) {
    assert.ok(r.metrics[k].percentile >= 0 && r.metrics[k].percentile <= 100);
  }
});

test('evaluateRecord: 24개월 이상은 선 키 표(wfh)', () => {
  const child = { birthDate: '2022-01-01', sex: 'female' };
  const r = G.evaluateRecord(child, { date: '2025-01-01', heightCm: 95, weightKg: 14 });
  assert.ok(r.metrics.wfh && !r.metrics.wfl);
});

test('evaluateRecord: 측정일이 생일보다 빠르면 오류', () => {
  const r = G.evaluateRecord({ birthDate: '2025-06-01', sex: 'male' }, { date: '2025-05-01', weightKg: 3 });
  assert.ok(r.error);
});

test('detectTrend: 백분위 하락 감지', () => {
  const child = { birthDate: '2025-01-01', sex: 'male' };
  // 체중을 일부러 75p → 20p 로 떨어뜨린 3회 측정
  const dates = ['2025-07-01', '2025-09-01', '2025-11-01'];
  const targets = [75, 45, 20];
  const recs = dates.map((d, i) => ({
    date: d, weightKg: G.growthValueAtPercentile('wfa', 'male', targets[i], G.daysBetween(child.birthDate, d))
  }));
  const evals = recs.map(r => G.evaluateRecord(child, r));
  const t = G.detectTrend(evals, 'wfa');
  assert.equal(t.trend, 'down');
  assert.match(t.message, /75p → 20p/);
  assert.match(t.message, /소아과/);
});

test('detectTrend: 곡선을 따라가면 stable', () => {
  const child = { birthDate: '2025-01-01', sex: 'female' };
  const evals = ['2025-04-01', '2025-07-01', '2025-10-01'].map(d => G.evaluateRecord(child, {
    date: d, weightKg: G.growthValueAtPercentile('wfa', 'female', 40, G.daysBetween(child.birthDate, d))
  }));
  const t = G.detectTrend(evals, 'wfa');
  assert.equal(t.trend, 'stable');
});

test('detectTrend: 측정 1회면 null', () => {
  const child = { birthDate: '2025-01-01', sex: 'male' };
  assert.equal(G.detectTrend([G.evaluateRecord(child, { date: '2025-06-01', weightKg: 7 })], 'wfa'), null);
});

test('percentileText', () => {
  assert.equal(G.percentileText(0.4), '1p 미만');
  assert.equal(G.percentileText(99.6), '99p 초과');
  assert.equal(G.percentileText(47.3), '47p');
});
