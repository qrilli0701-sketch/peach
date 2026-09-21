/**
 * 배포용 단일 파일 생성.
 *   npm run bundle
 *
 * Apps Script 는 한 프로젝트에 파일이 여러 개여도 되지만, 웹 편집기에 9번 붙여넣는 건
 * 실수하기 쉽다. 전부 이어붙여 파일 하나로 만든다.
 * 서로 참조하는 건 전부 함수 안에서 일어나므로(호출 시점엔 이미 다 로드됨) 순서는
 * 읽기 좋은 순으로만 잡는다.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');

// 데이터 → 계산 → 시트 → 앱 순
const ORDER = [
  'data_lms.gs', 'data_schedule.gs',
  'lib_growth.gs', 'lib_schedule.gs', 'lib_visit.gs',
  'Setup.gs', 'Store.gs', 'Code.gs', 'Api.gs', 'Triggers.gs'
];

const missing = ORDER.filter(f => !fs.existsSync(path.join(SRC, f)));
if (missing.length) throw new Error('없는 파일: ' + missing.join(', '));
const extra = fs.readdirSync(SRC).filter(f => f.endsWith('.gs') && !ORDER.includes(f));
if (extra.length) throw new Error('ORDER 에 빠진 파일이 있습니다: ' + extra.join(', '));

const bar = '='.repeat(74);
let out = `/**
 * 우리 아이 — 아이 관리 웹앱 (배포용 단일 파일)
 *
 * 자동 생성 파일입니다. 고칠 때는 baby-app/src/ 를 고치고 \`npm run bundle\` 하세요.
 * 원본 ${ORDER.length}개 파일: ${ORDER.join(', ')}
 *
 * ┌─ 붙여넣은 뒤 할 일 ──────────────────────────────────────────────┐
 * │ 1. 아래 SPREADSHEET_ID 를 본인 스프레드시트 ID 로 바꾸기           │
 * │ 2. 함수 목록에서 setupSheets 실행 (탭 생성)                       │
 * │ 3. 배포 → 새 배포 → 웹 앱                                         │
 * │      실행 계정  : 웹 앱에 액세스하는 사용자                        │
 * │      액세스 권한: 모든 Google 계정 사용자                          │
 * │ 4. 함수 목록에서 installTriggers 실행 (주간 메일·캘린더·백업)      │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * HTML 파일 'Page' 는 따로 만들어야 합니다 (src/Page.html 내용 붙여넣기).
 */

`;

for (const f of ORDER) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8')
    // node 테스트용 export 는 Apps Script 에서 쓸모없으니 뺀다
    .replace(/\nif \(typeof module !== 'undefined' && module\.exports\) \{[\s\S]*?\n\}\n/g, '\n')
    .trim();
  out += `//${bar}\n// ${f}\n//${bar}\n\n${code}\n\n\n`;
}

fs.mkdirSync(DIST, { recursive: true });
const dest = path.join(DIST, '배포용_전체코드.gs');
fs.writeFileSync(dest, out);

// Page.html 도 같이 떨궈서 dist 하나만 보면 되게 한다
fs.copyFileSync(path.join(SRC, 'Page.html'), path.join(DIST, 'Page.html'));

console.log('생성:', dest);
console.log('  ', out.split('\n').length, '줄 /', fs.statSync(dest).size, '바이트');
console.log('생성:', path.join(DIST, 'Page.html'));
