/**
 * 대한민국 표준 예방접종 일정 + 영유아 건강검진 일정 마스터.
 *
 * ⚠️ 참고용이다. 최종 확인은 반드시 예방접종도우미(nip.kdca.go.kr)와 소아과에서.
 *    접종이 지연되면 남은 차수의 횟수·간격이 달라질 수 있다.
 *
 * 창(window) 표기
 *   startM/endM : 생후 개월 (달력 기준으로 더함 — 1/31 + 1개월 = 2/28)
 *   startD/endD : 생후 일수 (개월보다 우선)
 *   endPlusD    : endM 개월에 더할 일수 (검진 "4~6개월"은 6개월 30일까지가 실제 마감)
 *   minPrevD    : 직전 차수 실제 접종일로부터 최소 간격(일). 지연 시 재계산에 쓰임
 *   series      : 같은 code 안의 선택지 (로타·일본뇌염처럼 백신 종류로 일정이 갈리는 경우)
 */

var VACCINE_SCHEDULE = [
  { code: 'BCG', name: '결핵 (BCG, 피내용)', nip: true, doses: [
    { n: 1, startD: 0, endD: 28, note: '생후 4주 이내' }
  ]},

  { code: 'HepB', name: 'B형간염', nip: true, doses: [
    { n: 1, startD: 0, endD: 7, note: '출생 후 12시간 이내 권장' },
    { n: 2, startM: 1, endM: 2, minPrevD: 28 },
    { n: 3, startM: 6, endM: 8, minPrevD: 56 }
  ]},

  { code: 'DTaP', name: '디프테리아·파상풍·백일해 (DTaP)', nip: true, doses: [
    { n: 1, startM: 2, endM: 3 },
    { n: 2, startM: 4, endM: 5, minPrevD: 28 },
    { n: 3, startM: 6, endM: 7, minPrevD: 28 },
    { n: 4, startM: 15, endM: 18, minPrevD: 180, note: '3차 후 6개월 이상' },
    { n: 5, startM: 48, endM: 72, minPrevD: 180, note: '만 4~6세' }
  ]},

  { code: 'IPV', name: '폴리오 (IPV)', nip: true, doses: [
    { n: 1, startM: 2, endM: 3 },
    { n: 2, startM: 4, endM: 5, minPrevD: 28 },
    { n: 3, startM: 6, endM: 18, minPrevD: 28 },
    { n: 4, startM: 48, endM: 72, minPrevD: 180, note: '만 4~6세' }
  ]},

  { code: 'Hib', name: 'b형 헤모필루스인플루엔자 (Hib)', nip: true, doses: [
    { n: 1, startM: 2, endM: 3 },
    { n: 2, startM: 4, endM: 5, minPrevD: 28 },
    { n: 3, startM: 6, endM: 7, minPrevD: 28 },
    { n: 4, startM: 12, endM: 15, minPrevD: 56, note: '추가접종' }
  ]},

  { code: 'PCV', name: '폐렴구균 (PCV, 단백결합)', nip: true, doses: [
    { n: 1, startM: 2, endM: 3 },
    { n: 2, startM: 4, endM: 5, minPrevD: 28 },
    { n: 3, startM: 6, endM: 7, minPrevD: 28 },
    { n: 4, startM: 12, endM: 15, minPrevD: 56, note: '추가접종' }
  ]},

  { code: 'RV', name: '로타바이러스', nip: true, series: 'rota', doses: [], variants: {
    'RV1': { label: '로타릭스 (2회)', doses: [
      { n: 1, startM: 2, endM: 3, note: '생후 15주 0일 이전 시작' },
      { n: 2, startM: 4, endM: 5, minPrevD: 28, note: '생후 8개월 0일 이전 완료' }
    ]},
    'RV5': { label: '로타텍 (3회)', doses: [
      { n: 1, startM: 2, endM: 3, note: '생후 15주 0일 이전 시작' },
      { n: 2, startM: 4, endM: 5, minPrevD: 28 },
      { n: 3, startM: 6, endM: 7, minPrevD: 28, note: '생후 8개월 0일 이전 완료' }
    ]}
  }},

  { code: 'MMR', name: '홍역·유행성이하선염·풍진 (MMR)', nip: true, doses: [
    { n: 1, startM: 12, endM: 15 },
    { n: 2, startM: 48, endM: 72, minPrevD: 28, note: '만 4~6세' }
  ]},

  { code: 'VAR', name: '수두', nip: true, doses: [
    { n: 1, startM: 12, endM: 15 }
  ]},

  { code: 'HepA', name: 'A형간염', nip: true, doses: [
    { n: 1, startM: 12, endM: 23 },
    { n: 2, startM: 18, endM: 35, minPrevD: 180, note: '1차 후 6~12개월' }
  ]},

  { code: 'JE', name: '일본뇌염', nip: true, series: 'je', doses: [], variants: {
    'IJEV': { label: '불활성화 백신 (5회)', doses: [
      { n: 1, startM: 12, endM: 23 },
      { n: 2, startM: 13, endM: 24, minPrevD: 28, note: '1차 후 1개월' },
      { n: 3, startM: 24, endM: 35, minPrevD: 335, note: '2차 후 12개월' },
      { n: 4, startM: 72, endM: 83, note: '만 6세' },
      { n: 5, startM: 144, endM: 155, note: '만 12세' }
    ]},
    'LJEV': { label: '약독화 생백신 (2회)', doses: [
      { n: 1, startM: 12, endM: 23 },
      { n: 2, startM: 24, endM: 35, minPrevD: 335, note: '1차 후 12개월' }
    ]}
  }},

  { code: 'IIV', name: '인플루엔자 (독감)', nip: true, annual: true, doses: [
    { n: 1, startM: 6, endM: 216, note: '생후 6개월부터 매년 가을. 첫 해는 4주 간격 2회' }
  ]},

  { code: 'Tdap', name: '파상풍·디프테리아·백일해 (Tdap/Td)', nip: true, doses: [
    { n: 1, startM: 132, endM: 155, note: '만 11~12세' }
  ]},

  { code: 'HPV', name: '사람유두종바이러스 (HPV)', nip: true, doses: [
    { n: 1, startM: 144, endM: 155, note: '만 12세 (2026년부터 남아 포함)' },
    { n: 2, startM: 150, endM: 167, minPrevD: 180, note: '1차 후 6개월' }
  ]}
];

/** 콤보백신 안내 — 일정 자체는 개별 백신 기준으로 계산하고, 화면에 참고 문구만 띄운다 */
var VACCINE_COMBO_NOTE =
  '5가(DTaP-IPV/Hib) 또는 6가(DTaP-IPV-Hib-HepB) 콤보백신을 쓰면 실제 주사 횟수가 줄어듭니다. ' +
  '어떤 걸 맞았는지는 접종 기록에 메모로 남겨두세요.';

/** 영유아 건강검진 (국가건강검진) — 2024년 개편 8차 + 구강 4회 */
var CHECKUP_SCHEDULE = [
  { kind: '영유아', n: 1, startD: 14, endD: 35, note: '건강교육·문진·진찰' },
  { kind: '영유아', n: 2, startM: 4,  endM: 6,  endPlusD: 30 },
  { kind: '영유아', n: 3, startM: 9,  endM: 12, endPlusD: 30 },
  { kind: '영유아', n: 4, startM: 18, endM: 24, endPlusD: 30, note: '발달평가 시작' },
  { kind: '영유아', n: 5, startM: 30, endM: 36, endPlusD: 30 },
  { kind: '영유아', n: 6, startM: 42, endM: 48, endPlusD: 30 },
  { kind: '영유아', n: 7, startM: 54, endM: 60, endPlusD: 30 },
  { kind: '영유아', n: 8, startM: 66, endM: 71, endPlusD: 30 },
  { kind: '구강',   n: 1, startM: 18, endM: 29, endPlusD: 30 },
  { kind: '구강',   n: 2, startM: 30, endM: 41, endPlusD: 30 },
  { kind: '구강',   n: 3, startM: 42, endM: 53, endPlusD: 30 },
  { kind: '구강',   n: 4, startM: 54, endM: 65, endPlusD: 30 }
];

/** 행정 일정 — 기한을 놓치면 돈이나 자리를 잃는 것들 */
var ADMIN_SCHEDULE = [
  { code: 'birth-report', name: '출생신고', startD: 0, endD: 30,
    note: '출생 후 1개월 이내. 지나면 과태료' },
  { code: 'child-allowance', name: '아동수당 신청', startD: 0, endD: 60,
    note: '출생일 포함 60일 이내 신청하면 출생월부터 소급 지급' },
  { code: 'parent-allowance', name: '부모급여 신청', startD: 0, endD: 60,
    note: '60일 이내 신청 시 출생월부터 소급' },
  { code: 'daycare-waitlist', name: '어린이집 입소 대기 등록', startD: 0, endD: 90,
    note: '임신육아종합포털 아이사랑. 대기 순번이 길어 일찍 걸어두는 게 유리' },
  { code: 'insurance', name: '어린이 보험 가입 검토', startD: 0, endD: 180,
    note: '가입 전 질병 이력이 생기면 인수에 불리해질 수 있음' }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VACCINE_SCHEDULE: VACCINE_SCHEDULE, CHECKUP_SCHEDULE: CHECKUP_SCHEDULE,
                     ADMIN_SCHEDULE: ADMIN_SCHEDULE, VACCINE_COMBO_NOTE: VACCINE_COMBO_NOTE };
}
