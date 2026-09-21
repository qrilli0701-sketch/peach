/**
 * 시간 기반 트리거 — 주간 요약 메일, 캘린더 동기화, 백업.
 * installTriggers() 를 소유자 계정에서 한 번 실행하면 설치된다.
 */

function installTriggers() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    var h = existing[i].getHandlerFunction();
    if (h === 'weeklyDigest' || h === 'syncCalendar' || h === 'weeklyBackup') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  var day = parseInt(getSetting('알림요일', '1'), 10) || 1;
  var hour = parseInt(getSetting('알림시각', '8'), 10);
  if (!(hour >= 0 && hour <= 23)) hour = 8;

  var WEEKDAYS = [null, ScriptApp.WeekDay.MONDAY, ScriptApp.WeekDay.TUESDAY,
                  ScriptApp.WeekDay.WEDNESDAY, ScriptApp.WeekDay.THURSDAY,
                  ScriptApp.WeekDay.FRIDAY, ScriptApp.WeekDay.SATURDAY, ScriptApp.WeekDay.SUNDAY];

  ScriptApp.newTrigger('weeklyDigest').timeBased()
    .onWeekDay(WEEKDAYS[day] || ScriptApp.WeekDay.MONDAY).atHour(hour).create();
  ScriptApp.newTrigger('syncCalendar').timeBased().everyDays(1).atHour(7).create();
  ScriptApp.newTrigger('weeklyBackup').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();

  return '트리거 설치 완료 — 주간요약(' + day + '요일 ' + hour + '시), 캘린더 동기화(매일 7시), 백업(일요일 3시)';
}

/* ── 주간 요약 메일 ───────────────────────────────────── */

function weeklyDigest() {
  var today = todayYmd();
  var recipients = String(getSetting('허용이메일', '')).split(',')
    .map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  if (!recipients.length) return;

  var kids = children_();
  if (!kids.length) return;

  var blocks = [];
  for (var i = 0; i < kids.length; i++) {
    var c = child_(kids[i]['아이ID']);
    var plan = buildFullPlan(c, c.options, doneMap_(c.id), today);
    var g = planDigest(plan, today, 14);
    if (!g.overdue.length && !g.open.length && !g.soon.length) continue;

    var html = '<h2 style="margin:24px 0 8px">' + esc_(c.name) + ' · ' +
               esc_(ageLabel(c.birthDate, today)) + '</h2>';
    // 목록보다 '언제 한 번 가면 되는지'가 먼저다
    var vp = planVisits(plan, today);
    if (vp.visits.length) {
      var v = vp.visits[0];
      html += '<div style="background:#f1f3f4;border-radius:10px;padding:14px 16px;margin:8px 0 16px">' +
        '<div style="font-size:13px;color:#5f6368">다음 병원 방문</div>' +
        '<div style="font-size:24px;font-weight:bold;margin:2px 0 6px">' +
          esc_(visitDateLabel(v.date)) + '</div>' +
        '<div style="font-size:15px;font-weight:bold;color:' +
          (v.overdueCount ? '#c5221f' : '#1a73e8') + '">' + esc_(visitSummary(v, today)) + '</div>' +
        '<div style="font-size:13px;color:#5f6368;margin-top:4px">' +
          esc_(visitReason(v, today)) + '</div>' +
        '<div style="font-size:13px;color:#3c4043;margin-top:10px">' +
          esc_(v.items.map(function (it) {
            return it.name.replace(/\s*\([^)]*\)/g, '') + (it.dose ? ' ' + it.dose + '차' : '');
          }).join(' · ')) + '</div>' +
        '</div>';
    }

    html += section_('지났습니다', g.overdue, today, '#c5221f');
    html += section_('지금 하실 수 있습니다', g.open, today, '#188038');
    html += section_('2주 안에 시작됩니다', g.soon, today, '#5f6368');
    blocks.push(html);
  }
  if (!blocks.length) return;

  var url = ScriptApp.getService().getUrl();
  var body = '<div style="font-family:-apple-system,\'Malgun Gothic\',sans-serif;max-width:600px">' +
    '<p style="color:#5f6368;font-size:13px;margin:0">' + today + ' 우리 아이 주간 요약</p>' +
    blocks.join('') +
    (url ? '<p style="margin-top:24px"><a href="' + url + '" style="background:#1a73e8;color:#fff;' +
           'padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">앱에서 보기</a></p>' : '') +
    '<p style="color:#9aa0a6;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">' +
    '참고용입니다. 접종·검진 일정은 예방접종도우미(nip.kdca.go.kr)와 소아과에서 확인하세요.</p></div>';

  MailApp.sendEmail({
    to: recipients.join(','),
    subject: '[우리 아이] ' + today + ' 이번 주 챙길 것',
    htmlBody: body
  });
}

function section_(title, items, today, color) {
  if (!items.length) return '';
  var html = '<p style="margin:12px 0 4px;font-weight:bold;color:' + color + '">' + title + '</p><ul style="margin:0;padding-left:20px">';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    html += '<li style="margin:4px 0">' + esc_(it.name) +
            (it.dose ? ' ' + it.dose + '차' : '') +
            ' <span style="color:#5f6368">(' + esc_(dDayText(it, today)) + ', ~' + it.end + ')</span></li>';
  }
  return html + '</ul>';
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── 캘린더 동기화 ───────────────────────────────────── */

/**
 * 30일 안에 마감되는 미완료 항목을 캘린더에 종일 일정으로 넣는다.
 * 같은 항목을 중복 생성하지 않도록 제목에 키를 심어 두고 지운 뒤 다시 만든다.
 */
function syncCalendar() {
  var calId = String(getSetting('캘린더ID', '')).trim();
  var cal = calId ? CalendarApp.getCalendarById(calId) : CalendarApp.getDefaultCalendar();
  if (!cal) return;

  var today = todayYmd();
  var horizonEnd = addDays(today, 30);
  var kids = children_();

  // 기존에 이 앱이 만든 일정 정리
  var from = new Date(ymdToUtc(today) - 86400000);
  var to = new Date(ymdToUtc(addDays(today, 40)));
  var old = cal.getEvents(from, to);
  for (var i = 0; i < old.length; i++) {
    if (old[i].getTag('babyapp') === '1') old[i].deleteEvent();
  }

  for (var k = 0; k < kids.length; k++) {
    var c = child_(kids[k]['아이ID']);
    var plan = buildFullPlan(c, c.options, doneMap_(c.id), today);
    for (var j = 0; j < plan.length; j++) {
      var it = plan[j];
      if (it.doneDate || it.needsChoice) continue;
      if (it.status !== ST_OVERDUE && it.status !== ST_OPEN) continue;
      if (it.end > horizonEnd) continue;

      var title = '[' + c.name + '] ' + it.name + (it.dose ? ' ' + it.dose + '차' : '') +
                  (it.status === ST_OVERDUE ? ' (기한 지남)' : '');
      var when = it.status === ST_OVERDUE ? today : it.end;   // 마감일에 알림
      var ev = cal.createAllDayEvent(title, new Date(ymdToUtc(when)), {
        description: '창: ' + it.start + ' ~ ' + it.end + (it.note ? '\n' + it.note : '') +
                     '\n\n참고용입니다. 확인: nip.kdca.go.kr'
      });
      ev.setTag('babyapp', '1');
    }
  }
}

/* ── 백업 ─────────────────────────────────────────────── */

/** 스프레드시트 사본을 백업 폴더에 만들고 최근 8개만 남긴다 */
function weeklyBackup() {
  var file = DriveApp.getFileById(SPREADSHEET_ID);
  var parents = file.getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();

  var folders = parent.getFoldersByName('백업');
  var folder = folders.hasNext() ? folders.next() : parent.createFolder('백업');

  var stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  file.makeCopy('아이관리_백업_' + stamp, folder);

  var items = [], it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf('아이관리_백업_') === 0) items.push(f);
  }
  items.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  for (var i = 8; i < items.length; i++) items[i].setTrashed(true);

  return '백업 완료 (' + Math.min(items.length + 1, 8) + '개 보관)';
}
