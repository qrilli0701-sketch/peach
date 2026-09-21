/**
 * 모든 .gs 파일과 Page.html 안의 스크립트가 문법적으로 유효한지 확인한다.
 * Apps Script 편집기에 붙여넣고 나서야 오타를 발견하는 일을 막기 위한 것.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const gsFiles = fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort();

test('src 에 .gs 파일이 있다', () => assert.ok(gsFiles.length >= 8, gsFiles.join(',')));

for (const f of gsFiles) {
  test(`${f} 문법 확인`, () => {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.doesNotThrow(() => new vm.Script(code, { filename: f }));
  });
}

test('Page.html 안의 스크립트 문법 확인', () => {
  const html = fs.readFileSync(path.join(SRC, 'Page.html'), 'utf8');
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length >= 1, '<script> 블록이 없습니다');
  blocks.forEach((code, i) => {
    assert.doesNotThrow(() => new vm.Script(code, { filename: `Page.html#${i}` }));
  });
});

test('Page.html: 태그 균형', () => {
  const html = fs.readFileSync(path.join(SRC, 'Page.html'), 'utf8');
  for (const tag of ['html', 'head', 'body', 'style', 'script', 'nav', 'header', 'main', 'dialog']) {
    const open = (html.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, `<${tag}> ${open}개 / </${tag}> ${close}개`);
  }
});

test('프런트가 부르는 api 액션이 Api.gs 에 모두 있다', () => {
  const html = fs.readFileSync(path.join(SRC, 'Page.html'), 'utf8');
  const api = fs.readFileSync(path.join(SRC, 'Api.gs'), 'utf8');
  const called = new Set([...html.matchAll(/call\(\s*'([a-zA-Z]+)'/g)].map(m => m[1]));
  assert.ok(called.size > 5, `호출이 너무 적음: ${[...called]}`);
  for (const a of called) {
    assert.match(api, new RegExp(`\\n  ${a}:\\s*function`), `Api.gs 에 ${a} 액션이 없습니다`);
  }
});

test('Apps Script 가 못 쓰는 최신 문법이 .gs 에 섞여 있지 않다', () => {
  // V8 런타임이면 대부분 되지만, 이 프로젝트는 ES5 스타일로 통일한다 (Rhino 호환 + 일관성)
  for (const f of gsFiles) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bconst\s|\blet\s/.test(stripped), `${f}: const/let 대신 var 를 쓰세요`);
    assert.ok(!/=>/.test(stripped), `${f}: 화살표 함수 대신 function 을 쓰세요`);
    assert.ok(!/`/.test(stripped), `${f}: 템플릿 리터럴 대신 문자열 연결을 쓰세요`);
  }
});

test('SPREADSHEET_ID 를 바꾸라는 자리표시자가 남아 있다 (배포 전 교체용)', () => {
  const setup = fs.readFileSync(path.join(SRC, 'Setup.gs'), 'utf8');
  assert.match(setup, /PUT_YOUR_SPREADSHEET_ID_HERE/,
    '실제 스프레드시트 ID 가 저장소에 커밋되지 않았는지 확인하세요');
});
