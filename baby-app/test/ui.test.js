/**
 * 브라우저 렌더링 검증.
 * 단위테스트는 CSS 를 모른다 — 실제로 화면이 깨지는 건 여기서만 잡힌다.
 * (스위치가 아래로 밀려나던 버그가 이 테스트가 생긴 이유다)
 *
 * playwright 가 없으면 건너뛴다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

let chromium = null;
try { chromium = require('playwright').chromium; } catch (e) { /* devDependency 미설치 */ }

const PREINSTALLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const skip = chromium ? false : 'playwright 미설치';
const PORT = 8788;
const TABS = ['today', 'growth', 'sched', 'log'];

async function withPage(scheme, fn) {
  const { boot, serve } = require('../tools/preview');
  const server = await serve(boot(), PORT);
  const browser = await chromium.launch(
    fs.existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {});
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    colorScheme: scheme || 'light', locale: 'ko-KR'
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.tiles', { timeout: 15000 });
    await fn(page, errors);
  } finally {
    await browser.close();
    server.close();
  }
}

test('모든 탭이 오류 없이 렌더링된다', { skip }, async () => {
  await withPage('light', async (page, errors) => {
    for (const tab of TABS) {
      await page.click('#nav-' + tab);
      await page.waitForTimeout(400);
      const n = await page.locator('#view *').count();
      assert.ok(n > 5, `${tab} 탭이 비어 있습니다`);
      assert.ok(await page.locator('#nav-' + tab + '.on').count() === 1, `${tab} 탭 표시 안 됨`);
    }
    assert.deepEqual(errors, []);
  });
});

test('휴대폰 폭에서 가로 스크롤이 생기지 않는다', { skip }, async () => {
  await withPage('light', async (page) => {
    for (const tab of TABS) {
      await page.click('#nav-' + tab);
      await page.waitForTimeout(400);
      const over = await page.evaluate(() => {
        const d = document.documentElement;
        return { scroll: d.scrollWidth, client: d.clientWidth };
      });
      assert.ok(over.scroll <= over.client + 1,
        `${tab}: 가로 넘침 ${over.scroll} > ${over.client}`);
    }
  });
});

test('스위치는 라벨과 같은 줄, 오른쪽에 놓인다', { skip }, async () => {
  // .field label{display:block} 이 .check 의 flex 를 덮어써서 스위치가 아래로
  // 밀려났던 적이 있다. 좌표로 확인한다.
  await withPage('light', async (page) => {
    await page.click('#nav-log');
    await page.waitForTimeout(300);
    await page.click('.quick button:nth-child(2)');       // 이유식
    await page.waitForSelector('.switch', { timeout: 5000 });

    const box = await page.evaluate(() => {
      const sw = document.querySelector('.switch').getBoundingClientRect();
      const txt = document.querySelector('.check .txt').getBoundingClientRect();
      return { sw: { x: sw.x, y: sw.y, w: sw.width, h: sw.height },
               txt: { x: txt.x, y: txt.y, w: txt.width, h: txt.height } };
    });
    assert.ok(Math.abs(box.sw.w - 51) < 2, '스위치 폭이 51px 이어야 합니다: ' + box.sw.w);
    assert.ok(Math.abs(box.sw.h - 31) < 2, '스위치 높이가 31px 이어야 합니다: ' + box.sw.h);
    assert.ok(box.sw.x > box.txt.x + box.txt.w - 2, '스위치가 글자 오른쪽에 있어야 합니다');
    // 같은 줄: 세로로 겹친다
    assert.ok(box.sw.y < box.txt.y + box.txt.h && box.txt.y < box.sw.y + box.sw.h,
      '스위치가 라벨과 같은 줄에 있어야 합니다');
  });
});

test('스위치를 켜면 초록으로 바뀌고 손잡이가 움직인다', { skip }, async () => {
  await withPage('light', async (page) => {
    await page.click('#nav-log');
    await page.waitForTimeout(300);
    await page.click('.quick button:nth-child(2)');
    await page.waitForSelector('.switch');
    const before = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.switch .knob')).transform);
    await page.click('.switch input');
    await page.waitForTimeout(350);
    const after = await page.evaluate(() => ({
      knob: getComputedStyle(document.querySelector('.switch .knob')).transform,
      track: getComputedStyle(document.querySelector('.switch .track')).backgroundColor,
      checked: document.querySelector('.switch input').checked
    }));
    assert.equal(after.checked, true);
    assert.notEqual(after.knob, before, '손잡이가 움직여야 합니다');
    assert.match(after.track, /52,\s*199,\s*89/, '켜진 트랙은 systemGreen 이어야 합니다');
  });
});

test('바텀 시트는 화면 아래에 붙는다', { skip }, async () => {
  // margin:0 auto auto 때문에 시트가 화면 위에 붙어 있던 적이 있다
  await withPage('light', async (page) => {
    await page.click('#nav-log');
    await page.waitForTimeout(300);
    await page.click('.quick button:nth-child(1)');
    await page.waitForSelector('.sheet');
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const s = document.querySelector('.sheet').getBoundingClientRect();
      return { bottom: s.bottom, top: s.top, vh: window.innerHeight, w: s.width };
    });
    assert.ok(Math.abs(r.bottom - r.vh) < 2, `시트 아래가 화면 바닥에 붙어야 합니다 (${r.bottom} vs ${r.vh})`);
    assert.ok(r.top > r.vh * 0.2, '시트가 화면 위쪽까지 차지하면 안 됩니다');
    assert.ok(r.w <= 390, '시트가 화면 폭을 넘지 않아야 합니다');
  });
});

test('다크 모드에서 배경과 카드가 실제로 달라진다', { skip }, async () => {
  const read = async scheme => {
    let out;
    await withPage(scheme, async (page) => {
      out = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        card: getComputedStyle(document.querySelector('.list')).backgroundColor,
        label: getComputedStyle(document.body).color
      }));
    });
    return out;
  };
  const light = await read('light');
  const dark = await read('dark');
  assert.notEqual(light.body, dark.body, '배경색이 테마에 따라 바뀌어야 합니다');
  assert.notEqual(light.label, dark.label, '글자색이 테마에 따라 바뀌어야 합니다');
  assert.notEqual(dark.body, dark.card, '다크 모드에서 배경과 카드가 구분돼야 합니다');
});

test('행의 제목과 부제가 각각 줄을 차지한다', { skip }, async () => {
  // .t/.d 가 inline span 이라 "이름2026-09-21 ~ ..." 로 붙어 나오던 적이 있다
  await withPage('light', async (page) => {
    await page.click('#nav-sched');
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.row')].find(x => x.querySelector('.d'));
      const t = row.querySelector('.t').getBoundingClientRect();
      const d = row.querySelector('.d').getBoundingClientRect();
      return { tBottom: t.bottom, dTop: d.top, tx: t.x, dx: d.x };
    });
    assert.ok(r.dTop >= r.tBottom - 1, '부제가 제목 아래 줄에 있어야 합니다');
    assert.ok(Math.abs(r.tx - r.dx) < 1, '제목과 부제의 왼쪽이 맞아야 합니다');
  });
});
