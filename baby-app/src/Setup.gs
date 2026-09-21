/**
 * 시트 스키마 정의 + 초기 생성.
 * 처음 한 번 setupSheets() 를 실행하면 탭과 헤더가 만들어진다. 이후 실행해도 안전(멱등).
 */

/** 스프레드시트 ID — 배포 전에 반드시 교체 */
var SPREADSHEET_ID = 'PUT_YOUR_SPREADSHEET_ID_HERE';
var TZ = 'Asia/Seoul';

/**
 * 열 타입
 *   text   : 문자열. 서식 '@' (전화번호 앞자리 0, 날짜 자동변환 방지)
 *   number : 숫자
 *   date   : 'yyyy-MM-dd' 문자열로 저장. 서식 '@' — 시트가 날짜로 바꿔 타임존이 밀리는 사고를 막는다
 */
var SCHEMA = {
  '설정': [
    ['키', 'text'], ['값', 'text'], ['설명', 'text']
  ],
  '아이': [
    ['아이ID', 'text'], ['이름', 'text'], ['생년월일', 'date'], ['성별', 'text'],
    ['혈액형', 'text'], ['알레르기', 'text'], ['특이사항', 'text'],
    ['로타백신', 'text'], ['일본뇌염백신', 'text'], ['활성', 'text']
  ],
  '성장기록': [
    ['기록ID', 'text'], ['아이ID', 'text'], ['측정일', 'date'],
    ['키cm', 'number'], ['몸무게kg', 'number'], ['머리둘레cm', 'number'],
    ['측정장소', 'text'], ['기록자', 'text'], ['메모', 'text']
  ],
  '일정완료': [
    ['아이ID', 'text'], ['항목키', 'text'], ['완료일', 'date'],
    ['기관', 'text'], ['기록자', 'text'], ['메모', 'text']
  ],
  '할일': [
    ['할일ID', 'text'], ['아이ID', 'text'], ['제목', 'text'], ['분류', 'text'],
    ['기한', 'date'], ['담당', 'text'], ['상태', 'text'], ['완료일', 'date'], ['메모', 'text']
  ],
  '생활기록': [
    ['기록ID', 'text'], ['아이ID', 'text'], ['일시', 'text'], ['유형', 'text'],
    ['값1', 'text'], ['값2', 'text'], ['상세', 'text'], ['기록자', 'text']
  ],
  '병원': [
    ['방문ID', 'text'], ['아이ID', 'text'], ['날짜', 'date'], ['기관', 'text'],
    ['증상', 'text'], ['진단', 'text'], ['처방', 'text'], ['비용', 'number'],
    ['다음예약', 'date'], ['메모', 'text']
  ]
};

/** 최초 1회 실행 — 탭·헤더·서식 생성 */
function setupSheets() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  ss.setSpreadsheetTimeZone(TZ);

  for (var name in SCHEMA) {
    var cols = SCHEMA[name];
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = cols.map(function (c) { return c[0]; });

    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      // 이미 있으면 헤더만 맞춰준다 (열 추가에 대응)
      var cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), headers.length)).getValues()[0];
      for (var i = 0; i < headers.length; i++) {
        if (cur[i] !== headers[i]) sh.getRange(1, i + 1).setValue(headers[i]);
      }
    }
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);

    // 문자열 열은 서식을 '@' 로 고정
    for (var c = 0; c < cols.length; c++) {
      if (cols[c][1] !== 'number') {
        sh.getRange(1, c + 1, sh.getMaxRows(), 1).setNumberFormat('@');
      }
    }
  }

  seedSettings_(ss);
  SpreadsheetApp.flush();
  return '완료: ' + Object.keys(SCHEMA).join(', ');
}

function seedSettings_(ss) {
  var sh = ss.getSheetByName('설정');
  if (sh.getLastRow() > 1) return;   // 이미 값이 있으면 건드리지 않는다
  sh.getRange(2, 1, 4, 3).setValues([
    ['허용이메일', Session.getEffectiveUser().getEmail(),
     '쉼표로 구분. 여기 적힌 계정만 앱을 열 수 있습니다'],
    ['알림요일', '1', '주간 요약 메일 요일 (1=월 … 7=일)'],
    ['알림시각', '8', '주간 요약 메일 시각 (0~23)'],
    ['캘린더ID', '', '비워두면 기본 캘린더. 마감 임박 항목을 여기에 넣습니다']
  ]);
}

/** 설치 확인용 — 편집기에서 실행해 로그로 상태를 본다 */
function checkSetup() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var lines = ['스프레드시트: ' + ss.getName(), '타임존: ' + ss.getSpreadsheetTimeZone()];
  for (var name in SCHEMA) {
    var sh = ss.getSheetByName(name);
    lines.push((sh ? '  O ' : '  X ') + name + (sh ? ' (' + Math.max(0, sh.getLastRow() - 1) + '행)' : ' 없음'));
  }
  lines.push('허용이메일: ' + getSetting('허용이메일'));
  var out = lines.join('\n');
  Logger.log(out);
  return out;
}
