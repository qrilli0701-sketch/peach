/**
 * 성장 백분위 계산 — 순수 함수만. SpreadsheetApp 등 Apps Script API 를 쓰지 않는다.
 * (node 에서 그대로 로드해 단위테스트 가능 — test/growth.test.js)
 *
 * LMS(Box-Cox) 방식:
 *   L ≠ 0 :  z = ((X/M)^L − 1) / (L·S)
 *   L = 0 :  z = ln(X/M) / S
 *   백분위 = Φ(z) × 100
 *
 * ⚠️ 의학적 판단 도구가 아니다. 해석은 소아과에서.
 */

/** 지표 코드 */
var G_WEIGHT = 'wfa';   // 체중-연령
var G_HEIGHT = 'lhfa';  // 신장-연령
var G_HEAD   = 'hcfa';  // 머리둘레-연령
var G_BMI    = 'bfa';   // BMI-연령
var G_WFL    = 'wfl';   // 체중-신장 (24개월 미만, 누운 키)
var G_WFH    = 'wfh';   // 체중-신장 (24개월 이상, 선 키)

var GROWTH_LABELS = {
  wfa: '몸무게', lhfa: '키', hcfa: '머리둘레', bfa: 'BMI', wfl: '키 대비 몸무게', wfh: '키 대비 몸무게'
};

/* ── 정규분포 ─────────────────────────────────────────────── */

/** 표준정규 누적분포 Φ(z). Hart(1968) 유리함수 근사 — 배정밀도 수준. */
function normalCdf(z) {
  if (z !== z) return NaN;
  if (z < -37) return 0;
  if (z > 37) return 1;
  var a = Math.abs(z), e, c;
  if (a < 7.071067811865475) {
    e = Math.exp(-a * a / 2);
    c = (((((3.52624965998911e-02 * a + 0.700383064443688) * a + 6.37396220353165) * a +
        33.912866078383) * a + 112.079291497871) * a + 221.213596169931) * a + 220.206867912376;
    var d = ((((((8.83883476483184e-02 * a + 1.75566716318264) * a + 16.064177579207) * a +
        86.7807322029461) * a + 296.564248779674) * a + 637.333633378831) * a +
        793.826512519948) * a + 440.413735824752;
    c = e * c / d;
  } else {
    c = Math.exp(-a * a / 2) /
        (a + 1 / (a + 2 / (a + 3 / (a + 4 / (a + 0.65))))) / 2.506628274631;
  }
  return z > 0 ? 1 - c : c;
}

/** Φ⁻¹(p) — Acklam 근사 + Halley 1회 보정. 0<p<1 */
function normalInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
           1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
           6.680131188771972e+01, -1.328068155288572e+01];
  var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
           -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
           3.754408661907416e+00];
  var pl = 0.02425, q, r, x;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= 1 - pl) {
    q = p - 0.5; r = q * q;
    x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
        (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  var e = normalCdf(x) - p;
  var u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

/* ── LMS ─────────────────────────────────────────────────── */

/**
 * 지표·성별 테이블에서 x(일령 또는 신장cm) 위치의 L,M,S 를 선형보간해 반환.
 * 범위를 벗어나면 양끝 값으로 고정하고 clamped=true.
 */
function lmsAt(indicator, sex, x) {
  var key = indicator + '_' + (sex === 'female' || sex === '여' ? 'f' : 'm');
  var t = LMS_TABLES[key];
  if (!t) throw new Error('알 수 없는 성장지표: ' + indicator);
  var xs = LMS_X[t.x];
  var lo = xs[0], hi = xs[xs.length - 1], clamped = false;
  if (x <= lo) { x = lo; clamped = true; }
  if (x >= hi) { x = hi; clamped = true; }

  // 이진탐색: xs[i] <= x <= xs[i+1]
  var a = 0, b = xs.length - 1;
  while (b - a > 1) { var mid = (a + b) >> 1; if (xs[mid] <= x) a = mid; else b = mid; }
  var span = xs[b] - xs[a];
  var f = span === 0 ? 0 : (x - xs[a]) / span;
  return {
    L: t.L[a] + (t.L[b] - t.L[a]) * f,
    M: t.M[a] + (t.M[b] - t.M[a]) * f,
    S: t.S[a] + (t.S[b] - t.S[a]) * f,
    clamped: clamped
  };
}

/** 측정값 → z-score */
function zFromLms(value, L, M, S) {
  if (!(value > 0) || !(M > 0) || !(S > 0)) return NaN;
  return L === 0 ? Math.log(value / M) / S : (Math.pow(value / M, L) - 1) / (L * S);
}

/** z-score → 측정값 (백분위 밴드 그릴 때 사용) */
function valueFromZ(z, L, M, S) {
  return L === 0 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L);
}

/**
 * 측정값 평가.
 * @param {string} indicator G_WEIGHT 등
 * @param {string} sex 'male' | 'female' | '남' | '여'
 * @param {number} value 측정값 (kg 또는 cm)
 * @param {number} x 일령(연령지표) 또는 신장cm(체중-신장지표)
 * @return {{indicator,zScore,percentile,median,x,clamped}}
 */
function growthEvaluate(indicator, sex, value, x) {
  var p = lmsAt(indicator, sex, x);
  var z = zFromLms(value, p.L, p.M, p.S);
  return {
    indicator: indicator,
    zScore: z,
    percentile: normalCdf(z) * 100,
    median: p.M,
    x: x,
    clamped: p.clamped
  };
}

/** 특정 백분위에 해당하는 측정값 — 그래프 밴드용 */
function growthValueAtPercentile(indicator, sex, percentile, x) {
  var p = lmsAt(indicator, sex, x);
  return valueFromZ(normalInv(percentile / 100), p.L, p.M, p.S);
}

/* ── 나이·BMI ────────────────────────────────────────────── */

/** 'yyyy-MM-dd' 두 개로 일령 계산. 시분초·타임존 영향을 받지 않게 UTC 정오 기준. */
function daysBetween(fromYmd, toYmd) {
  var a = ymdToUtc(fromYmd), b = ymdToUtc(toYmd);
  return Math.round((b - a) / 86400000);
}

function ymdToUtc(ymd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim());
  if (!m) throw new Error('날짜 형식은 yyyy-MM-dd 여야 합니다: ' + ymd);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
}

function utcToYmd(ms) {
  var d = new Date(ms);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

/** ymd 에 일수를 더한 ymd */
function addDays(ymd, n) { return utcToYmd(ymdToUtc(ymd) + n * 86400000); }

/** ymd 에 개월수를 더한 ymd (말일 보정: 1/31 + 1개월 = 2/28) */
function addMonths(ymd, n) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim());
  var y = +m[1], mo = +m[2] - 1 + n, d = +m[3];
  var last = new Date(Date.UTC(y, mo + 1, 0, 12)).getUTCDate();
  return utcToYmd(Date.UTC(y, mo, Math.min(d, last), 12));
}

/** 사람이 읽는 나이: "생후 14개월 3일" / "2세 5개월" */
function ageLabel(birthYmd, onYmd) {
  var days = daysBetween(birthYmd, onYmd);
  if (days < 0) return '출생 전';
  if (days < 31) return '생후 ' + days + '일';
  var months = 0;
  while (daysBetween(addMonths(birthYmd, months + 1), onYmd) >= 0) months++;
  var rest = daysBetween(addMonths(birthYmd, months), onYmd);
  if (months < 24) return '생후 ' + months + '개월 ' + rest + '일';
  return Math.floor(months / 12) + '세 ' + (months % 12) + '개월';
}

/** 만 월령 (정수) */
function ageMonths(birthYmd, onYmd) {
  if (daysBetween(birthYmd, onYmd) < 0) return -1;
  var m = 0;
  while (daysBetween(addMonths(birthYmd, m + 1), onYmd) >= 0) m++;
  return m;
}

function bmiOf(weightKg, heightCm) {
  if (!(weightKg > 0) || !(heightCm > 0)) return null;
  var m = heightCm / 100;
  return weightKg / (m * m);
}

/* ── 기록 한 건 평가 ─────────────────────────────────────── */

/**
 * 성장기록 1건을 아이 정보와 합쳐 전체 지표로 평가.
 * @param {{birthDate:string, sex:string}} child
 * @param {{date:string, heightCm:number, weightKg:number, headCm:number}} rec
 */
function evaluateRecord(child, rec) {
  var days = daysBetween(child.birthDate, rec.date);
  var out = { date: rec.date, ageDays: days, ageLabel: ageLabel(child.birthDate, rec.date), metrics: {} };
  if (days < 0) { out.error = '측정일이 생년월일보다 빠릅니다'; return out; }

  if (rec.heightCm > 0) out.metrics[G_HEIGHT] = growthEvaluate(G_HEIGHT, child.sex, rec.heightCm, days);
  if (rec.weightKg > 0) out.metrics[G_WEIGHT] = growthEvaluate(G_WEIGHT, child.sex, rec.weightKg, days);
  if (rec.headCm > 0 && days <= 1856) out.metrics[G_HEAD] = growthEvaluate(G_HEAD, child.sex, rec.headCm, days);

  if (rec.heightCm > 0 && rec.weightKg > 0) {
    var b = bmiOf(rec.weightKg, rec.heightCm);
    out.bmi = b;
    out.metrics[G_BMI] = growthEvaluate(G_BMI, child.sex, b, days);
    // 키 대비 몸무게: 24개월 기준으로 누운 키/선 키 표를 나눠 쓴다
    var wf = days < 730 ? G_WFL : G_WFH;
    out.metrics[wf] = growthEvaluate(wf, child.sex, rec.weightKg, rec.heightCm);
  }
  return out;
}

/* ── 추세 감지 ───────────────────────────────────────────── */

/**
 * 백분위가 곡선을 가로지르며 내려가는지/올라가는지 감지.
 * 절대 백분위보다 "변화"가 임상적으로 더 중요한 신호다.
 * @param {Array} evaluated evaluateRecord 결과 배열 (날짜 오름차순)
 * @param {string} indicator
 * @return {{trend:string, message:string, points:Array}|null}
 */
function detectTrend(evaluated, indicator) {
  var pts = [];
  for (var i = 0; i < evaluated.length; i++) {
    var mt = evaluated[i].metrics[indicator];
    if (mt && isFinite(mt.zScore)) pts.push({ date: evaluated[i].date, z: mt.zScore, p: mt.percentile });
  }
  if (pts.length < 2) return null;

  var recent = pts.slice(-3);
  var dz = recent[recent.length - 1].z - recent[0].z;
  var label = GROWTH_LABELS[indicator];
  var from = Math.round(recent[0].p), to = Math.round(recent[recent.length - 1].p);
  var res = { trend: 'stable', message: '', points: pts, deltaZ: dz };

  // z 1.0 (백분위 곡선 2칸) 이상 이동이면 눈여겨볼 변화
  if (dz <= -1.0) {
    res.trend = 'down';
    res.message = label + ' 백분위가 ' + from + 'p → ' + to + 'p 로 떨어졌습니다. 소아과에서 확인해 보세요.';
  } else if (dz >= 1.0) {
    res.trend = 'up';
    res.message = label + ' 백분위가 ' + from + 'p → ' + to + 'p 로 올랐습니다.';
  } else {
    res.message = label + ' 백분위 ' + to + 'p, 곡선 따라 안정적입니다.';
  }
  return res;
}

/** 백분위를 사람 말로 */
function percentileText(p) {
  if (!isFinite(p)) return '-';
  if (p < 1) return '1p 미만';
  if (p > 99) return '99p 초과';
  return Math.round(p) + 'p';
}

/* node 테스트에서 꺼내 쓰기 위한 노출 (Apps Script 에서는 무시됨) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalCdf: normalCdf, normalInv: normalInv, lmsAt: lmsAt, zFromLms: zFromLms,
    valueFromZ: valueFromZ, growthEvaluate: growthEvaluate,
    growthValueAtPercentile: growthValueAtPercentile, daysBetween: daysBetween,
    addDays: addDays, addMonths: addMonths, ageLabel: ageLabel, ageMonths: ageMonths,
    bmiOf: bmiOf, evaluateRecord: evaluateRecord, detectTrend: detectTrend,
    percentileText: percentileText, utcToYmd: utcToYmd
  };
}
