/**
 * .gs 파일들을 하나의 vm 컨텍스트에 로드해 순수 함수를 node 에서 테스트할 수 있게 한다.
 * Apps Script 런타임 없이 돌아가므로 CI/로컬에서 바로 실행 가능.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

function loadGs(files) {
  const sandbox = { console, Math, Date, JSON, isFinite, isNaN, parseInt, parseFloat, Infinity, NaN };
  vm.createContext(sandbox);
  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  return sandbox;
}

module.exports = { loadGs };
