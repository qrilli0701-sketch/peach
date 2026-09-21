/**
 * dist/배포용_전체코드.gs 검증.
 * 사장님이 실제로 붙여넣는 건 이 파일이므로, src 가 아니라 이 파일로 한 바퀴 돌려본다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('node:child_process');
const { makeEnv } = require('./appsscript.mock');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'dist', '배포용_전체코드.gs');
const PAGE = path.join(ROOT, 'dist', 'Page.html');

test('번들이 src 와 같은 내용이다 (npm run bundle 을 깜빡하지 않았는지)', () => {
  const before = fs.readFileSync(BUNDLE, 'utf8');
  execFileSync('node', [path.join(ROOT, 'tools', 'bundle.js')], { cwd: ROOT });
  assert.equal(fs.readFileSync(BUNDLE, 'utf8'), before,
    'src 를 고친 뒤 npm run bundle 을 실행하세요');
  assert.equal(fs.readFileSync(PAGE, 'utf8'), fs.readFileSync(path.join(ROOT, 'src', 'Page.html'), 'utf8'));
});

test('번들에 원본 9개 파일이 모두 들어 있다', () => {
  const code = fs.readFileSync(BUNDLE, 'utf8');
  const srcFiles = fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.gs'));
  assert.equal(srcFiles.length, 9);
  for (const f of srcFiles) assert.ok(code.includes('// ' + f), `${f} 가 번들에 없음`);
});

test('번들에 node 전용 export 가 남아 있지 않다', () => {
  const code = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(!code.includes('module.exports'), 'Apps Script 에서 module 은 정의되지 않는다');
});

test('배포 전 바꿔야 할 자리가 안내와 함께 남아 있다', () => {
  const code = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(code, /PUT_YOUR_SPREADSHEET_ID_HERE/);
  assert.match(code, /붙여넣은 뒤 할 일/);
  assert.match(code, /웹 앱에 액세스하는 사용자/);
  assert.match(code, /installTriggers/);
});

/** 번들 한 파일만 올려서 실제로 동작하는지 */
function bootFromBundle(opts) {
  const env = makeEnv(opts);
  const sandbox = Object.assign({ console, Math, JSON, isFinite, isNaN, parseInt, parseFloat,
                                  Infinity, NaN, String, Number, Object, Array, Error, RegExp }, env);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'bundle.gs' });
  vm.runInContext("SPREADSHEET_ID = 'test-sheet'; setupSheets();", sandbox);
  sandbox._env = env;
  return sandbox;
}

test('번들 한 파일만으로 전체 흐름이 돈다', () => {
  const S = bootFromBundle({ now: '2026-09-21' });
  const ok = (a, p) => { const r = S.api(a, p || {}); if (!r.ok) throw new Error(a + ': ' + r.error); return r.data; };

  const id = ok('childSave', { name: '아기', birthDate: '2026-03-21', sexLabel: '남' }).id;
  ok('vaccineChoice', { childId: id, series: 'rota', choice: 'RV5' });
  ok('growthAdd', { childId: id, date: '2026-09-21', heightCm: 68.5, weightKg: 8.1, headCm: 44.2 });
  ok('logAdd', { childId: id, type: '이유식', v1: '소고기', v2: '신규' });
  ok('scheduleBulkDone', { childId: id, items: [{ key: 'BCG#1', date: '2026-03-25' }] });

  const d = ok('dashboard', { childId: id });
  assert.equal(d.child.ageLabel, '생후 6개월 0일');
  assert.ok(d.growth.metrics.wfa.percentile > 0 && d.growth.metrics.wfa.percentile < 100);
  assert.equal(d.foodWatch.length, 1);
  assert.ok(d.open.some(x => x.key === 'DTaP#3'));

  const ch = ok('growthChart', { childId: id, indicator: 'wfa' });
  assert.equal(ch.bands.length, 5);
  assert.equal(ch.points.length, 1);

  // 트리거 함수도 번들 안에서 호출된다
  vm.runInContext('weeklyDigest();', S);
  assert.equal(S._env.sentMail.length, 1);
  vm.runInContext('syncCalendar();', S);
  assert.ok(S._env.calendarEvents.length > 0);
  assert.match(vm.runInContext('checkSetup();', S), /아이 \(1행\)/);
});

test('appsscript.json 이 배포 설정과 일치한다', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'appsscript.json'), 'utf8'));
  assert.equal(m.timeZone, 'Asia/Seoul');
  assert.equal(m.runtimeVersion, 'V8');
  assert.equal(m.webapp.executeAs, 'USER_ACCESSING', '누가 기록했는지 알려면 접속자 권한으로 실행해야 한다');
  assert.equal(m.webapp.access, 'ANYONE', '구글 로그인은 요구하되 실제 통과는 허용이메일로 거른다');
  assert.notEqual(m.webapp.access, 'ANYONE_ANONYMOUS', '로그인 없이 열리면 안 된다');
  for (const scope of ['spreadsheets', 'drive', 'calendar', 'script.send_mail',
                       'script.scriptapp', 'userinfo.email']) {
    assert.ok(m.oauthScopes.some(s => s.endsWith('/' + scope)), `${scope} 권한 누락`);
  }
});
