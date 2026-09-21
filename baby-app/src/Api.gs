/**
 * API 액션 구현. Code.gs 의 api() 가 여기로 넘긴다.
 * 계산은 lib_growth.gs / lib_schedule.gs (순수 함수) 에 있고 여기서는 시트 입출력만 한다.
 */

/** 새 식재료를 며칠간 지켜볼지 */
var FOOD_WATCH_DAYS = 3;

/* ── 조회 헬퍼 ───────────────────────────────────────── */

function children_() {
  return readTable('아이').filter(function (c) { return String(c['활성']) !== 'N'; });
}

function child_(childId) {
  var all = readTable('아이');
  for (var i = 0; i < all.length; i++) {
    if (String(all[i]['아이ID']) === String(childId)) {
      return {
        id: all[i]['아이ID'], name: all[i]['이름'],
        birthDate: String(all[i]['생년월일']).trim(),
        sex: String(all[i]['성별']).trim() === '여' ? 'female' : 'male',
        sexLabel: String(all[i]['성별']).trim() || '남',
        blood: all[i]['혈액형'], allergy: all[i]['알레르기'], note: all[i]['특이사항'],
        options: { rota: all[i]['로타백신'] || '', je: all[i]['일본뇌염백신'] || '' }
      };
    }
  }
  throw new Error('아이를 찾을 수 없습니다: ' + childId);
}

/** 일정완료 탭 → {항목키: 완료일} */
function doneMap_(childId) {
  var out = {};
  readTable('일정완료').forEach(function (r) {
    if (String(r['아이ID']) === String(childId) && r['완료일']) {
      out[r['항목키']] = String(r['완료일']).trim();
    }
  });
  return out;
}

function growthRecords_(childId) {
  return readTable('성장기록')
    .filter(function (r) { return String(r['아이ID']) === String(childId); })
    .map(function (r) {
      return {
        id: r['기록ID'], date: String(r['측정일']).trim(),
        heightCm: num_(r['키cm']), weightKg: num_(r['몸무게kg']), headCm: num_(r['머리둘레cm']),
        place: r['측정장소'], by: r['기록자'], memo: r['메모']
      };
    })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

/* ── 액션 ────────────────────────────────────────────── */

var API_ACTIONS = {

  /** 앱 첫 로딩 — 필요한 걸 한 번에 내려준다 */
  bootstrap: function (p, ctx) {
    var kids = children_().map(function (c) {
      return { id: c['아이ID'], name: c['이름'], birthDate: String(c['생년월일']).trim(),
               sexLabel: c['성별'] };
    });
    return { user: ctx.email, who: ctx.who, today: ctx.today, children: kids,
             comboNote: VACCINE_COMBO_NOTE };
  },

  childSave: function (p, ctx) {
    var id = p.id || newId('kid');
    if (!p.name) throw new Error('이름을 입력해 주세요');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.birthDate || ''))) {
      throw new Error('생년월일을 yyyy-MM-dd 로 입력해 주세요');
    }
    if (daysBetween(p.birthDate, ctx.today) < 0) throw new Error('생년월일이 미래입니다');
    upsertRow('아이', '아이ID', id, {
      '아이ID': id, '이름': p.name, '생년월일': p.birthDate,
      '성별': p.sexLabel === '여' ? '여' : '남',
      '혈액형': p.blood || '', '알레르기': p.allergy || '', '특이사항': p.note || '',
      '로타백신': p.rota || '', '일본뇌염백신': p.je || '', '활성': 'Y'
    });
    return { id: id };
  },

  /** 홈 화면 — 할 일 묶음 + 오늘 요약 + 성장 한 줄 */
  dashboard: function (p, ctx) {
    var c = child_(p.childId);
    var plan = buildFullPlan(c, c.options, doneMap_(c.id), ctx.today);
    var digest = planDigest(plan, ctx.today, 60);

    function slim(list) {
      return list.map(function (it) {
        return { key: it.key, name: it.name, dose: it.dose, totalDoses: it.totalDoses,
                 variant: it.variant, start: it.start, end: it.end, status: it.status,
                 dday: dDayText(it, ctx.today), alert: needsAlert(it, ctx.today),
                 note: it.note, shifted: it.shifted, needsChoice: it.needsChoice,
                 choices: it.choices, code: it.code };
      });
    }

    var recs = growthRecords_(c.id);
    var evals = recs.map(function (r) { return evaluateRecord(c, r); });
    var latest = evals.length ? evals[evals.length - 1] : null;
    var growth = null;
    if (latest) {
      growth = { date: latest.date, ageLabel: latest.ageLabel, metrics: {}, trends: [] };
      var lastRec = recs[recs.length - 1];
      var rawOf = { lhfa: lastRec.heightCm, wfa: lastRec.weightKg, hcfa: lastRec.headCm };
      [G_HEIGHT, G_WEIGHT, G_HEAD].forEach(function (k) {
        var m = latest.metrics[k];
        if (m) growth.metrics[k] = { label: GROWTH_LABELS[k], percentile: m.percentile,
                                     text: percentileText(m.percentile), z: m.zScore,
                                     value: rawOf[k], unit: k === G_WEIGHT ? 'kg' : 'cm' };
      });
      [G_HEIGHT, G_WEIGHT].forEach(function (k) {
        var t = detectTrend(evals, k);
        if (t && t.trend !== 'stable') growth.trends.push({ indicator: k, trend: t.trend, message: t.message });
      });
    }

    return {
      child: { id: c.id, name: c.name, birthDate: c.birthDate, sexLabel: c.sexLabel,
               ageLabel: ageLabel(c.birthDate, ctx.today),
               ageMonths: ageMonths(c.birthDate, ctx.today) },
      overdue: slim(digest.overdue), open: slim(digest.open), soon: slim(digest.soon),
      doneCount: digest.done.length,
      todos: readTable('할일').filter(function (t) {
        return String(t['아이ID']) === String(c.id) && String(t['상태']) !== '완료';
      }).map(function (t) {
        return { id: t['할일ID'], title: t['제목'], due: String(t['기한'] || '').trim(),
                 owner: t['담당'], category: t['분류'] };
      }).sort(function (a, b) { return (a.due || '9999') < (b.due || '9999') ? -1 : 1; }),
      growth: growth,
      todaySummary: todaySummary_(c.id, ctx.today),
      foodWatch: API_ACTIONS.foodWatch({ childId: c.id }, ctx).watching
    };
  },

  /** 접종·검진 전체 타임라인 */
  schedule: function (p, ctx) {
    var c = child_(p.childId);
    var done = doneMap_(c.id);
    var plan = buildFullPlan(c, c.options, done, ctx.today);
    return {
      comboNote: VACCINE_COMBO_NOTE,
      options: c.options,
      items: plan.map(function (it) {
        return { key: it.key, code: it.code, name: it.name, dose: it.dose,
                 totalDoses: it.totalDoses, variant: it.variant,
                 start: it.start, end: it.end, status: it.status,
                 doneDate: it.doneDate, dday: dDayText(it, ctx.today),
                 alert: needsAlert(it, ctx.today), note: it.note, shifted: it.shifted,
                 needsChoice: it.needsChoice, choices: it.choices, free: it.free };
      })
    };
  },

  /** 접종/검진 완료 체크. date 없으면 오늘. */
  scheduleDone: function (p, ctx) {
    if (!p.key) throw new Error('항목이 지정되지 않았습니다');
    var c = child_(p.childId);
    var date = p.date || ctx.today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식은 yyyy-MM-dd');
    if (daysBetween(c.birthDate, date) < 0) throw new Error('생년월일보다 빠른 날짜입니다');
    deleteWhere('일정완료', { '아이ID': c.id, '항목키': p.key });
    appendRow('일정완료', {
      '아이ID': c.id, '항목키': p.key, '완료일': date,
      '기관': p.place || '', '기록자': ctx.who, '메모': p.memo || ''
    });
    return { key: p.key, date: date };
  },

  /**
   * 지금까지 맞은 것 일괄 입력.
   * 6개월 아이를 처음 등록하면 이미 지난 항목이 20개가 넘는다.
   * 하나씩 누르게 하면 아무도 안 쓴다.
   */
  scheduleBulkDone: function (p, ctx) {
    var c = child_(p.childId);
    var items = p.items || [];
    if (!items.length) throw new Error('선택된 항목이 없습니다');

    var saved = 0, skipped = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.key) continue;
      var date = String(it.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped.push(it.key + ' (날짜 형식)'); continue; }
      if (daysBetween(c.birthDate, date) < 0) { skipped.push(it.key + ' (생년월일보다 빠름)'); continue; }
      if (daysBetween(date, ctx.today) < 0) { skipped.push(it.key + ' (미래 날짜)'); continue; }

      deleteWhere('일정완료', { '아이ID': c.id, '항목키': it.key });
      appendRow('일정완료', {
        '아이ID': c.id, '항목키': it.key, '완료일': date,
        '기관': it.place || '', '기록자': ctx.who,
        '메모': it.approx ? '일괄 입력 (날짜 추정)' : '일괄 입력'
      });
      saved++;
    }
    return { saved: saved, skipped: skipped };
  },

  scheduleUndone: function (p, ctx) {
    var c = child_(p.childId);
    deleteWhere('일정완료', { '아이ID': c.id, '항목키': p.key });
    return { key: p.key };
  },

  /** 백신 종류 선택 (로타·일본뇌염) */
  vaccineChoice: function (p, ctx) {
    var c = child_(p.childId);
    var col = p.series === 'rota' ? '로타백신' : p.series === 'je' ? '일본뇌염백신' : null;
    if (!col) throw new Error('알 수 없는 백신 구분: ' + p.series);

    // 마스터에 실제로 있는 선택지인지 확인 (임의 값이 들어오면 일정이 사라진다)
    var valid = [''];
    for (var i = 0; i < VACCINE_SCHEDULE.length; i++) {
      var v = VACCINE_SCHEDULE[i];
      if (v.series === p.series && v.variants) {
        for (var k in v.variants) valid.push(k);
      }
    }
    var choice = p.choice || '';
    if (valid.indexOf(choice) < 0) throw new Error('알 수 없는 백신 종류: ' + choice);

    var patch = {};
    patch[col] = choice;
    updateRow('아이', '아이ID', c.id, patch);
    return { series: p.series, choice: choice };
  },

  /* ── 성장 ─────────────────────────────────────────── */

  growth: function (p, ctx) {
    var c = child_(p.childId);
    var recs = growthRecords_(c.id);
    var evals = recs.map(function (r) { return evaluateRecord(c, r); });

    var rows = recs.map(function (r, i) {
      var e = evals[i], m = {};
      for (var k in e.metrics) {
        m[k] = { p: e.metrics[k].percentile, text: percentileText(e.metrics[k].percentile),
                 z: e.metrics[k].zScore, clamped: e.metrics[k].clamped };
      }
      return { id: r.id, date: r.date, ageLabel: e.ageLabel, ageDays: e.ageDays,
               heightCm: r.heightCm, weightKg: r.weightKg, headCm: r.headCm,
               bmi: e.bmi, place: r.place, by: r.by, memo: r.memo, metrics: m };
    });

    var trends = {};
    [G_HEIGHT, G_WEIGHT, G_HEAD, G_BMI].forEach(function (k) {
      var t = detectTrend(evals, k);
      if (t) trends[k] = { trend: t.trend, message: t.message, deltaZ: t.deltaZ };
    });

    return { child: { id: c.id, name: c.name, birthDate: c.birthDate, sexLabel: c.sexLabel },
             rows: rows, trends: trends, labels: GROWTH_LABELS };
  },

  /** 그래프용 — 백분위 밴드 + 우리 아이 점 */
  growthChart: function (p, ctx) {
    var c = child_(p.childId);
    var ind = p.indicator || G_WEIGHT;
    var recs = growthRecords_(c.id);
    var key = ind === G_HEIGHT ? 'heightCm' : ind === G_WEIGHT ? 'weightKg' : 'headCm';

    var maxDays = 1856;
    var span = Math.max(180, ageMonths(c.birthDate, ctx.today) * 31 + 120);
    var upto = Math.min(span, maxDays);

    var bands = [3, 15, 50, 85, 97].map(function (pc) {
      var pts = [];
      for (var d = 0; d <= upto; d += Math.max(7, Math.round(upto / 80))) {
        pts.push({ x: d, y: growthValueAtPercentile(ind, c.sex, pc, d) });
      }
      return { percentile: pc, points: pts };
    });

    var points = [];
    recs.forEach(function (r) {
      if (!(r[key] > 0)) return;
      var d = daysBetween(c.birthDate, r.date);
      if (d < 0 || d > maxDays) return;
      var ev = growthEvaluate(ind, c.sex, r[key], d);
      points.push({ x: d, y: r[key], date: r.date, percentile: ev.percentile });
    });

    return { indicator: ind, label: GROWTH_LABELS[ind], unit: ind === G_WEIGHT ? 'kg' : 'cm',
             maxDays: upto, bands: bands, points: points };
  },

  growthAdd: function (p, ctx) {
    var c = child_(p.childId);
    var date = p.date || ctx.today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식은 yyyy-MM-dd');
    if (daysBetween(c.birthDate, date) < 0) throw new Error('생년월일보다 빠른 날짜입니다');
    var h = num_(p.heightCm), w = num_(p.weightKg), hc = num_(p.headCm);
    if (h == null && w == null && hc == null) throw new Error('키·몸무게·머리둘레 중 하나는 입력해 주세요');
    if (h != null && (h < 20 || h > 200)) throw new Error('키 값을 확인해 주세요 (' + h + 'cm)');
    if (w != null && (w < 0.3 || w > 150)) throw new Error('몸무게 값을 확인해 주세요 (' + w + 'kg)');
    if (hc != null && (hc < 20 || hc > 70)) throw new Error('머리둘레 값을 확인해 주세요 (' + hc + 'cm)');

    var id = newId('g');
    appendRow('성장기록', {
      '기록ID': id, '아이ID': c.id, '측정일': date,
      '키cm': h == null ? '' : h, '몸무게kg': w == null ? '' : w,
      '머리둘레cm': hc == null ? '' : hc,
      '측정장소': p.place || '', '기록자': ctx.who, '메모': p.memo || ''
    });
    return { id: id, evaluated: evaluateRecord(c, { date: date, heightCm: h, weightKg: w, headCm: hc }) };
  },

  growthDelete: function (p, ctx) {
    return { deleted: deleteRow('성장기록', '기록ID', p.id) };
  },

  /* ── 할일 ─────────────────────────────────────────── */

  todoAdd: function (p, ctx) {
    if (!p.title) throw new Error('할 일 제목을 입력해 주세요');
    var id = newId('t');
    appendRow('할일', {
      '할일ID': id, '아이ID': p.childId || '', '제목': p.title, '분류': p.category || '기타',
      '기한': p.due || '', '담당': p.owner || '', '상태': '진행', '완료일': '', '메모': p.memo || ''
    });
    return { id: id };
  },

  todoDone: function (p, ctx) {
    updateRow('할일', '할일ID', p.id, { '상태': '완료', '완료일': ctx.today });
    return { id: p.id };
  },

  todoDelete: function (p, ctx) {
    return { deleted: deleteRow('할일', '할일ID', p.id) };
  },

  /* ── 생활기록 ─────────────────────────────────────── */

  logAdd: function (p, ctx) {
    if (!p.type) throw new Error('기록 유형이 없습니다');
    var id = newId('l');
    appendRow('생활기록', {
      '기록ID': id, '아이ID': p.childId || '', '일시': p.at || nowStamp(), '유형': p.type,
      '값1': p.v1 == null ? '' : String(p.v1), '값2': p.v2 == null ? '' : String(p.v2),
      '상세': p.detail || '', '기록자': ctx.who
    });
    return { id: id, at: p.at || nowStamp() };
  },

  logDelete: function (p, ctx) {
    return { deleted: deleteRow('생활기록', '기록ID', p.id) };
  },

  /** 최근 n일치 생활기록 */
  logs: function (p, ctx) {
    var days = p.days || 2;
    var from = addDays(ctx.today, -(days - 1));
    var rows = readTable('생활기록').filter(function (r) {
      return String(r['아이ID']) === String(p.childId) && String(r['일시']).slice(0, 10) >= from;
    }).map(function (r) {
      return { id: r['기록ID'], at: String(r['일시']), type: r['유형'],
               v1: r['값1'], v2: r['값2'], detail: r['상세'], by: r['기록자'] };
    });
    rows.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    return { rows: rows, summary: todaySummary_(p.childId, ctx.today) };
  },

  /**
   * 새 식재료 관찰 — 처음 먹인 재료는 3일간 이상반응을 지켜본다.
   * 나중에 뭐가 문제였는지 역추적하려면 '언제 처음 먹였는지'가 남아 있어야 한다.
   */
  foodWatch: function (p, ctx) {
    var from = addDays(ctx.today, -(FOOD_WATCH_DAYS - 1));
    var all = readTable('생활기록').filter(function (r) {
      return String(r['아이ID']) === String(p.childId) && r['유형'] === '이유식';
    });

    // 재료별 '처음 먹인 날' — 같은 재료를 여러 번 먹여도 관찰 기간은 첫 날부터 센다.
    // 오래된 것부터 훑어야 가장 이른 날짜가 잡힌다.
    var firstSeen = {};
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      var food = String(r['값1'] || '').trim();
      if (!food || String(r['값2']) !== '신규') continue;
      var day = String(r['일시']).slice(0, 10);
      if (!firstSeen[food] || day < firstSeen[food].day) {
        firstSeen[food] = { day: day, reaction: String(r['상세'] || '') };
      }
    }

    var watching = [];
    for (var food2 in firstSeen) {
      if (firstSeen[food2].day < from) continue;      // 관찰 기간이 끝났다
      watching.push({
        food: food2, startedOn: firstSeen[food2].day,
        dayNo: daysBetween(firstSeen[food2].day, ctx.today) + 1,
        totalDays: FOOD_WATCH_DAYS,
        reaction: firstSeen[food2].reaction
      });
    }
    watching.sort(function (a, b) { return a.startedOn < b.startedOn ? 1 : -1; });

    // 지금까지 도입한 재료 전체 (중복 제거)
    var introduced = [];
    var known = {};
    all.forEach(function (r) {
      var f = String(r['값1'] || '').trim();
      if (f && !known[f]) { known[f] = true; introduced.push(f); }
    });

    return { watching: watching, introduced: introduced, watchDays: FOOD_WATCH_DAYS };
  },

  /* ── 병원 ─────────────────────────────────────────── */

  clinicAdd: function (p, ctx) {
    var id = newId('c');
    appendRow('병원', {
      '방문ID': id, '아이ID': p.childId || '', '날짜': p.date || ctx.today,
      '기관': p.place || '', '증상': p.symptom || '', '진단': p.diagnosis || '',
      '처방': p.prescription || '', '비용': num_(p.cost) == null ? '' : num_(p.cost),
      '다음예약': p.nextVisit || '', '메모': p.memo || ''
    });
    return { id: id };
  },

  clinics: function (p, ctx) {
    var rows = readTable('병원')
      .filter(function (r) { return String(r['아이ID']) === String(p.childId); })
      .map(function (r) {
        return { id: r['방문ID'], date: String(r['날짜']).trim(), place: r['기관'],
                 symptom: r['증상'], diagnosis: r['진단'], prescription: r['처방'],
                 cost: r['비용'], nextVisit: String(r['다음예약'] || '').trim(), memo: r['메모'] };
      });
    rows.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    return { rows: rows };
  },

  /** 응급 카드 — 캡처해서 어린이집에 보내는 용도 */
  emergencyCard: function (p, ctx) {
    var c = child_(p.childId);
    var recs = growthRecords_(c.id);
    var last = recs.length ? recs[recs.length - 1] : null;
    var allergyLogs = readTable('생활기록').filter(function (r) {
      return String(r['아이ID']) === String(c.id) && r['유형'] === '투약';
    }).slice(-5);
    return {
      name: c.name, birthDate: c.birthDate, sexLabel: c.sexLabel,
      ageLabel: ageLabel(c.birthDate, ctx.today),
      blood: c.blood, allergy: c.allergy, note: c.note,
      weightKg: last ? last.weightKg : null,
      recentMeds: allergyLogs.map(function (r) { return { at: r['일시'], name: r['값1'] }; })
    };
  }
};

/* ── 오늘 요약 (부부 인수인계용) ───────────────────────── */

function todaySummary_(childId, today) {
  var rows = readTable('생활기록').filter(function (r) {
    return String(r['아이ID']) === String(childId) && String(r['일시']).slice(0, 10) === today;
  });
  rows.sort(function (a, b) { return String(a['일시']) < String(b['일시']) ? -1 : 1; });

  function last(type) {
    for (var i = rows.length - 1; i >= 0; i--) if (rows[i]['유형'] === type) return rows[i];
    return null;
  }
  function count(type) {
    var n = 0;
    for (var i = 0; i < rows.length; i++) if (rows[i]['유형'] === type) n++;
    return n;
  }

  // 유형이 늘어나도 '마지막으로 먹은 것'은 하나로 보여준다
  var feed = null;
  for (var f = rows.length - 1; f >= 0 && !feed; f--) {
    var ty = rows[f]['유형'];
    if (ty === '수유' || ty === '이유식' || ty === '식사') feed = rows[f];
  }
  var temp = last('체온');
  var sleepMin = 0;
  rows.forEach(function (r) {
    if (r['유형'] === '수면' && r['값1'] && r['값2']) {
      var a = String(r['값1']), b = String(r['값2']);
      var am = toMin_(a), bm = toMin_(b);
      if (am != null && bm != null) sleepMin += (bm >= am ? bm - am : bm + 1440 - am);
    }
  });

  return {
    lastFeed: feed ? { at: String(feed['일시']).slice(11), detail: feed['값1'], by: feed['기록자'] } : null,
    lastTemp: temp ? { at: String(temp['일시']).slice(11), value: temp['값1'], by: temp['기록자'] } : null,
    poopCount: count('배변'),
    sleepMinutes: sleepMin,
    medCount: count('투약'),
    memo: (last('메모') || {})['상세'] || '',
    entryCount: rows.length
  };
}

function toMin_(hhmm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
