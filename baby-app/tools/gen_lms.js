const m=require('./package/dist/index.cjs'); const fs=require('fs');
const SEX=['male','female'], AGE=['wfa','lhfa','hcfa','bfa'], LEN=['wfl','wfh'];
const MONTH=365.25/12, BREAKS=[730,731];

function ageXs(last){
  const xs=[];
  for(let d=0;d<=31;d++) xs.push(d);
  for(let d=35;d<=365;d+=7) xs.push(d);
  for(const b of BREAKS) xs.push(b);
  for(let k=1;;k++){ const v=Math.round(365+k*MONTH); if(v>last) break; xs.push(v); }
  xs.push(last);
  xs.sort((a,b)=>a-b);
  return xs.filter((v,i,a)=>i===0||v>a[i-1]);
}
function lenXs(t){ const last=t.start+(t.lms.length-1)*t.step; const a=[];
  for(let x=t.start;x<=last+1e-9;x+=0.5) a.push(Number(x.toFixed(1)));
  if(a[a.length-1]<last-1e-9) a.push(last); return a; }
function at(t,x){ const i=Math.round((x-t.start)/t.step); return t.lms[Math.min(Math.max(i,0),t.lms.length-1)]; }
const p6=v=>Number(v.toPrecision(6));

const X={}, TB={};
X.age = ageXs(m.getTable('wfa','male').lms.length-1);
X.wfl = lenXs(m.getTable('wfl','male'));
X.wfh = lenXs(m.getTable('wfh','male'));
for(const ind of AGE.concat(LEN)) for(const sex of SEX){
  const t=m.getTable(ind,sex); const xs = t.xAxis==='day' ? X.age : X[ind];
  const S=xs.map(x=>at(t,x));
  TB[ind+'_'+sex[0]] = { x: t.xAxis==='day'?'age':ind,
    L:S.map(a=>p6(a[0])), M:S.map(a=>p6(a[1])), S:S.map(a=>p6(a[2])) };
}
const j=a=>'['+a.join(',')+']';
let out=`/**
 * WHO Child Growth Standards — LMS 파라미터 (0~5세)
 * 자동 생성 파일. 손으로 고치지 말 것. (baby-app/tools/gen_lms.js)
 *
 * 출처: WHO Child Growth Standards (https://www.who.int/tools/child-growth-standards)
 *       npm who-growth-standards@1.0.1 에 번들된 공식 표에서 추출.
 * 대한민국 2017 소아청소년 성장도표는 0~35개월 구간에서 이 WHO 표준을 그대로 채택한다.
 * 36~60개월은 근사치이며, 3세 이상 한국 표준(KDCA)은 추후 별도 반영 필요. (기획.md 7항)
 *
 * 격자: 0~31일 매일 / ~365일 매주 / 이후 매월, 730·731일(누운키→선키 전환) 경계 포함.
 *       체중-신장표는 0.5cm 간격. 사이값은 L,M,S 선형보간.
 * 보간 오차: 원본 일 단위 표 대비 최악 |Δz| = 0.008 (검증: test/growth.test.js)
 */

var LMS_X = {
  age: ${j(X.age)},
  wfl: ${j(X.wfl)},
  wfh: ${j(X.wfh)}
};

var LMS_TABLES = {
`;
out += Object.entries(TB).map(([k,v])=>
`  ${k}: { x: '${v.x}', L: ${j(v.L)}, M: ${j(v.M)}, S: ${j(v.S)} }`).join(',\n');
out += '\n};\n';
fs.mkdirSync('out',{recursive:true});
fs.writeFileSync('out/data_lms.gs', out);
console.log('bytes', fs.statSync('out/data_lms.gs').size, '| age anchors', X.age.length,
            '| wfl', X.wfl.length, '| wfh', X.wfh.length);
fs.writeFileSync('out/gen_lms.js', fs.readFileSync('gen.js'));
