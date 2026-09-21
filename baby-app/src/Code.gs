/**
 * 아이 관리 웹앱 — 진입점, 인증, API 라우터.
 *
 * 배포 설정 (중요)
 *   실행 계정 : 웹 앱에 액세스하는 사용자
 *   액세스 권한: 모든 Google 계정 사용자
 * 이렇게 해야 Session.getActiveUser() 로 누가 썼는지 알 수 있고,
 * 스프레드시트를 부부 둘에게만 공유해 두면 URL 이 유출돼도 열리지 않는다.
 * (설정 탭의 '허용이메일' 로 한 겹 더 막는다)
 */

function doGet() {
  var t = HtmlService.createTemplateFromFile('Page');
  return t.evaluate()
    .setTitle('우리 아이')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Page.html 안에서 <?!= include('X') ?> 로 부분 파일을 끼워 넣을 때 사용 */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ── 인증 ─────────────────────────────────────────────── */

function currentUser_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) { email = ''; }
  if (!email) {
    try { email = Session.getEffectiveUser().getEmail() || ''; } catch (e2) { email = ''; }
  }
  return email;
}

function assertAllowed_() {
  var email = currentUser_();
  var raw = String(getSetting('허용이메일', '')).trim();
  if (!raw) {
    // 아직 설정 전이면 스프레드시트 접근 권한만으로 판단한다 (openById 가 이미 막아준다)
    return email || '(알 수 없음)';
  }
  var allowed = raw.split(',').map(function (s) { return s.trim().toLowerCase(); })
                   .filter(function (s) { return s; });
  if (allowed.indexOf(email.toLowerCase()) < 0) {
    throw new Error('접근 권한이 없습니다. (' + (email || '계정 확인 불가') + ')\n' +
                    '스프레드시트 설정 탭의 허용이메일에 이 주소를 추가하세요.');
  }
  return email;
}

/** 이름표 — 기록자 표시에 쓴다 */
function userLabel_(email) {
  var e = (email || '').toLowerCase();
  var map = String(getSetting('이름표', '')).trim();   // "a@x.com=아빠, b@x.com=엄마"
  if (map) {
    var parts = map.split(',');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv.length === 2 && kv[0].trim().toLowerCase() === e) return kv[1].trim();
    }
  }
  return e ? e.split('@')[0] : '?';
}

/* ── API 라우터 ───────────────────────────────────────── */

/**
 * 프런트에서는 google.script.run.api(action, payload) 하나만 호출한다.
 * (google.script.run 은 왕복이 느려서 엔드포인트를 늘리지 않는 편이 낫다)
 */
function api(action, payload) {
  try {
    var email = assertAllowed_();
    var ctx = { email: email, who: userLabel_(email), today: todayYmd() };
    var fn = API_ACTIONS[action];
    if (!fn) throw new Error('알 수 없는 요청: ' + action);
    return { ok: true, data: fn(payload || {}, ctx) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}
