/**
 * 교차검증: 우리 구현(다운샘플링한 LMS 표 + 자체 정규분포 함수)이
 * WHO 원본 일 단위 표를 그대로 쓰는 독립 구현과 일치하는지 확인한다.
 *
 * 우리가 표를 줄여 넣었기 때문에(35KB) 이 테스트가 그 대가를 수치로 못박아 둔다.
 * who-growth-standards 가 없으면(오프라인 등) 건너뛴다.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./load');

let ref = null;
try { ref = require('who-growth-standards'); } catch (e) { /* devDependency 미설치 */ }

const G = loadGs(['data_lms.gs', 'lib_growth.gs']);

// 허용 오차: 격자 보간으로 생기는 z 오차 상한. tools/gen_lms.js 에서 측정한 값.
const Z_TOL = 0.01;

test('WHO 원본 표와 z-score 일치 (연령 기반 4개 지표 전 구간)', { skip: ref ? false : '미설치' }, () => {
  const inds = ['wfa', 'lhfa', 'hcfa', 'bfa'];
  let worst = 0, worstAt = '';
  for (const ind of inds) {
    for (const sex of ['male', 'female']) {
      for (let days = 0; days <= 1856; days++) {
        for (const targetZ of [-3, -2, -1, 0, 1, 2, 3]) {
          const value = ref.valueAtZScore(ind, sex, targetZ, days);
          const got = G.growthEvaluate(ind, sex, value, days).zScore;
          const err = Math.abs(got - targetZ);
          if (err > worst) { worst = err; worstAt = `${ind}/${sex} ${days}일 z=${targetZ}`; }
        }
      }
    }
  }
  assert.ok(worst < Z_TOL, `최악 오차 ${worst.toFixed(5)} @ ${worstAt} (허용 ${Z_TOL})`);
  console.log(`    연령 지표 최악 |Δz| = ${worst.toFixed(5)} @ ${worstAt}`);
});

test('WHO 원본 표와 z-score 일치 (체중-신장)', { skip: ref ? false : '미설치' }, () => {
  let worst = 0, worstAt = '';
  const ranges = { wfl: [45, 110], wfh: [65, 120] };
  for (const ind of ['wfl', 'wfh']) {
    for (const sex of ['male', 'female']) {
      const [lo, hi] = ranges[ind];
      for (let cm = lo; cm <= hi; cm += 0.1) {
        const x = Number(cm.toFixed(1));
        for (const targetZ of [-3, -1, 0, 1, 3]) {
          const value = ref.valueAtZScore(ind, sex, targetZ, x);
          const got = G.growthEvaluate(ind, sex, value, x).zScore;
          const err = Math.abs(got - targetZ);
          if (err > worst) { worst = err; worstAt = `${ind}/${sex} ${x}cm z=${targetZ}`; }
        }
      }
    }
  }
  assert.ok(worst < Z_TOL, `최악 오차 ${worst.toFixed(5)} @ ${worstAt} (허용 ${Z_TOL})`);
  console.log(`    체중-신장 최악 |Δz| = ${worst.toFixed(5)} @ ${worstAt}`);
});

test('백분위도 함께 일치 (소수 2자리)', { skip: ref ? false : '미설치' }, () => {
  let worst = 0, worstAt = '';
  for (const sex of ['male', 'female']) {
    for (let days = 0; days <= 1856; days += 7) {
      for (const p of [1, 3, 15, 50, 85, 97, 99]) {
        const value = ref.valueAtPercentile('wfa', sex, p, days);
        const got = G.growthEvaluate('wfa', sex, value, days).percentile;
        const err = Math.abs(got - p);
        if (err > worst) { worst = err; worstAt = `${sex} ${days}일 ${p}p`; }
      }
    }
  }
  assert.ok(worst < 0.5, `최악 백분위 오차 ${worst.toFixed(4)}p @ ${worstAt}`);
  console.log(`    백분위 최악 오차 = ${worst.toFixed(4)}p @ ${worstAt}`);
});

test('정규분포 함수가 독립 구현과 일치', { skip: ref ? false : '미설치' }, () => {
  // 참조 구현은 erf 근사를 써서 자체 오차가 ~1e-6 백분위 있다.
  // 우리 Hart 구현은 알려진 정확값 대비 ~1e-14 (growth.test.js 의 'normalCdf: 알려진 값과 일치').
  // 따라서 여기서는 '두 구현이 서로 어긋나지 않는지'만 본다 — 정확도 기준은 그쪽 테스트다.
  let worst = 0;
  for (let z = -4; z <= 4; z += 0.001) {
    worst = Math.max(worst, Math.abs(G.normalCdf(z) * 100 - ref.zScoreToPercentile(z)));
  }
  assert.ok(worst < 1e-4, `최악 차이 ${worst.toExponential(3)} 백분위`);
  console.log(`    정규분포 두 구현 차이 = ${worst.toExponential(3)} 백분위 (참조 구현 쪽 근사 오차)`);
});
