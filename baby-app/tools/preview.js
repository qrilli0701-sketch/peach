/**
 * 로컬 미리보기 — Apps Script 에 배포하지 않고 화면을 눈으로 확인한다.
 *   node tools/preview.js          서버만 띄움 (http://localhost:8787)
 *   node tools/preview.js --shot   스크린샷을 dist/preview/ 에 저장
 *
 * google.script.run 을 fetch 로 바꿔치기하고, 그 뒤는 test/appsscript.mock.js 의
 * 가짜 런타임이 실제 Api.gs 를 돌린다. 즉 화면도 데이터도 진짜와 같은 경로를 탄다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { makeEnv } = require('../test/appsscript.mock');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TODAY = '2026-09-21';
const FILES = ['data_lms.gs', 'data_schedule.gs', 'lib_growth.gs', 'lib_schedule.gs',
               'lib_visit.gs', 'Setup.gs', 'Store.gs', 'Code.gs', 'Api.gs', 'Triggers.gs'];

/* ── 가짜 런타임 + 보여줄 만한 데이터 ─────────────────── */
function boot() {
  const env = makeEnv({ now: TODAY, email: 'papa@example.com' });
  const sb = Object.assign({ console, Math, JSON, isFinite, isNaN, parseInt, parseFloat,
                             Infinity, NaN, String, Number, Object, Array, Error, RegExp }, env);
  vm.createContext(sb);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sb, { filename: f });
  vm.runInContext("SPREADSHEET_ID='preview'; setupSheets();", sb);
  // seedSettings_ 는 이름표 행을 만들지 않으므로 여기서 추가한다 (updateRow 는 없는 행을 못 고친다)
  vm.runInContext("appendRow('설정',{'키':'이름표','값':'papa@example.com=아빠','설명':'미리보기'});", sb);

  const call = (a, p) => { const r = sb.api(a, p || {}); if (!r.ok) throw new Error(a + ': ' + r.error); return r.data; };
  const id = call('childSave', { name: '복숭', birthDate: '2026-03-21', sexLabel: '남' }).id;
  call('vaccineChoice', { childId: id, series: 'rota', choice: 'RV5' });

  // 성장 기록 — 백분위가 살짝 내려가는 흐름이라 추세 경고도 보인다
  [['2026-03-21', 50.2, 3.4, 34.8], ['2026-04-25', 55.1, 4.5, 37.6],
   ['2026-06-20', 63.0, 6.6, 41.3], ['2026-08-02', 66.4, 7.3, 42.9],
   ['2026-09-20', 68.1, 7.6, 43.8]].forEach(function (r) {
    call('growthAdd', { childId: id, date: r[0], heightCm: r[1], weightKg: r[2], headCm: r[3] });
  });

  // 이미 맞은 접종
  call('scheduleBulkDone', { childId: id, items: [
    { key: 'BCG#1', date: '2026-04-02' }, { key: 'HepB#1', date: '2026-03-21' },
    { key: 'HepB#2', date: '2026-04-22' }, { key: '영유아#1', date: '2026-04-10' },
    { key: 'DTaP#1', date: '2026-05-23' }, { key: 'IPV#1', date: '2026-05-23' },
    { key: 'Hib#1', date: '2026-05-23' }, { key: 'PCV#1', date: '2026-05-23' },
    { key: 'RV#1', date: '2026-05-23' },
    { key: 'DTaP#2', date: '2026-07-25' }, { key: 'IPV#2', date: '2026-07-25' },
    { key: 'Hib#2', date: '2026-07-25' }, { key: 'PCV#2', date: '2026-07-25' },
    { key: 'RV#2', date: '2026-07-25' },
    { key: 'admin#birth-report', date: '2026-03-24' },
    { key: 'admin#child-allowance', date: '2026-03-24' },
    { key: 'admin#parent-allowance', date: '2026-03-24' }
  ]});

  // 오늘의 생활기록
  [['수유', '160ml 분유', '', '', '2026-09-21 06:40'],
   ['수면', '09:10', '10:40', '', '2026-09-21 10:40'],
   ['이유식', '소고기', '신규', '잘 먹음', '2026-09-20 12:10'],
   ['이유식', '단호박죽', '', '2/3 먹음', '2026-09-21 12:20'],
   ['배변', '보통', '', '', '2026-09-21 13:05'],
   ['수유', '150ml 분유', '', '', '2026-09-21 15:30'],
   ['체온', '36.9', '', '', '2026-09-21 16:00'],
   ['메모', '', '', '낮잠이 짧았음. 저녁에 보챌 수 있어요', '2026-09-21 16:10']
  ].forEach(function (r) {
    call('logAdd', { childId: id, type: r[0], v1: r[1], v2: r[2], detail: r[3], at: r[4] });
  });

  call('todoAdd', { childId: id, title: '어린이집 입소 상담 전화', due: '2026-09-25', owner: '아빠' });
  call('todoAdd', { childId: id, title: '독감 예방접종 예약', due: '2026-09-30', owner: '엄마' });
  return sb;
}

/* ── google.script.run 을 fetch 로 바꿔치기 ───────────── */
const SHIM = `<script>
window.google = { script: { run: (function(){
  function chain(){
    var ok = null, bad = null;
    var o = {
      withSuccessHandler: function(f){ ok = f; return o; },
      withFailureHandler: function(f){ bad = f; return o; },
      api: function(action, payload){
        fetch('/api', { method:'POST', headers:{'Content-Type':'application/json'},
                        body: JSON.stringify({ action: action, payload: payload }) })
          .then(function(r){ return r.json(); })
          .then(function(r){ ok && ok(r); })
          .catch(function(e){ bad ? bad(e) : console.error(e); });
      }
    };
    return o;
  }
  return { withSuccessHandler: function(f){ return chain().withSuccessHandler(f); },
           withFailureHandler: function(f){ return chain().withFailureHandler(f); },
           api: function(a,p){ return chain().api(a,p); } };
})() } };
</script>`;

function serve(sb, port) {
  const html = fs.readFileSync(path.join(SRC, 'Page.html'), 'utf8')
                 .replace('<script>', SHIM + '\n<script>');
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          let out;
          try { const { action, payload } = JSON.parse(body); out = sb.api(action, payload); }
          catch (e) { out = { ok: false, error: String(e.message || e) }; }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(port, () => resolve(server));
  });
}

/* ── 스크린샷 ─────────────────────────────────────────── */

/** 문서 높이가 두 번 연속 같을 때까지 기다린 뒤 그 값을 돌려준다 */
async function stableHeight(page, tries) {
  let prev = -1;
  for (let i = 0; i < (tries || 20); i++) {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    if (h === prev) return h;
    prev = h;
    await page.waitForTimeout(120);
  }
  return prev;
}
async function shoot(port) {
  const { chromium } = require('playwright');
  const outDir = path.join(ROOT, 'dist', 'preview');
  fs.mkdirSync(outDir, { recursive: true });
  // 이 환경엔 크로미움이 미리 깔려 있다. playwright 버전과 빌드 번호가 달라도
  // 새로 내려받지 않고 그걸 그대로 쓴다.
  const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(
    fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  const tabs = [['today', '오늘'], ['growth', '성장'], ['sched', '일정']];

  for (const scheme of ['light', 'dark']) {
    // isMobile 을 켜면 이 크로미움 빌드에서 뷰포트 메타가 무시되고 980px 폭으로
    // 렌더링된다(= 태블릿 화면을 보게 된다). 폭만 고정하는 편이 실제 휴대폰에 가깝다.
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
      colorScheme: scheme, locale: 'ko-KR'
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.visit', { timeout: 10000 });

    for (const [tab, label] of tabs) {
      await page.click(`#nav-${tab}`);
      await page.waitForTimeout(500);
      // 탭을 옮긴 직후엔 직전 화면 높이가 남아 있다. 두 번 재서 같아질 때까지 기다린다.
      const h = await stableHeight(page);
      await page.screenshot({ path: path.join(outDir, `${scheme}-${tab}.png`), fullPage: true });
      process.stdout.write(`  ${scheme}/${label}(${h}) `);
    }
    // 바텀 시트 한 장 — '다녀왔어요'
    await page.click('#nav-today');
    await page.waitForTimeout(400);
    await page.click('.visit-acts .btn:nth-child(2)');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, `${scheme}-sheet.png`) });
    console.log(`${scheme}/시트`);

    if (errors.length) { console.log('\n  ⚠️ 콘솔 오류:'); errors.forEach(e => console.log('   ', e)); }
    await ctx.close();
  }
  await browser.close();
  console.log('저장: dist/preview/');
}

module.exports = { boot, serve };

if (require.main === module) {
  (async () => {
    const sb = boot();
    const port = 8787;
    const server = await serve(sb, port);
    if (process.argv.includes('--shot')) {
      try { await shoot(port); } finally { server.close(); }
    } else {
      console.log(`미리보기: http://localhost:${port}/  (Ctrl+C 로 종료)`);
    }
  })();
}
