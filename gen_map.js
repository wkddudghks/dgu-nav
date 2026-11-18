// 신공학관 지도 생성기 — 6층 안내도를 기준으로 모든 층(구조 동일)의 map.json을 만듭니다.
// 사용법:  node gen_map.js            → 기본 5층, 6층
//          node gen_map.js 4 5 6 7    → 원하는 층들
// 좌표 단위는 픽셀(안내도 사진 기준), PX_PER_M 픽셀 = 1m
const fs = require('fs');
const path = require('path');

const FLOORS = process.argv.slice(2).map(Number).filter(Boolean);
if (!FLOORS.length) FLOORS.push(5, 6);
// 축척: 7층에서 타일(53cm 정사각형)을 세어 구함 (11월 19일)
//  - 7136 옆 세로 복도 106칸 = 56.2m  → 이 지도에서 약 15.6px/m
//  - 7101 동쪽 벽 ~ 7136 서쪽 벽 13칸 = 6.9m → 약 15.8px/m
//  두 방향이 1% 안으로 맞아서 하나의 값으로 씀 (이전 어림값 18 → 실제 거리는 약 15% 더 김)
const PX_PER_M = 15.7;
const STAIR_COST = 12; // 한 층 오르내리는 비용(m 환산)
const EV_COST = 10;

// ESP32(스테이션)를 놓을 자리 — 6층, 길잡이 로봇 키패드 목적지 앞 복도 벽 (STATION_01 ~ 13)
//  D_xxx = 그 방 출입구 앞 복도 지점. 복도 맞은편으로 1~3m 안에 붙은 목적지는 비콘 하나를 같이 씀
//  (RSSI로는 3m 안의 두 비콘을 구별하기 어려움) → 남는 3개는 가운데 복도·복도 끝·갈림길에 둠
const STATION_FLOOR = 6;
const STATION_SPOTS = [
  ['D_103',        '6103 앞 (키 1)'],
  ['D_105',        '6105 · 중앙계단 앞 (키 2, D)'],
  ['D_107',        '6107 · 남자화장실 앞 (키 3, A)'],
  ['D_109',        '6109 · 여자화장실 앞 (키 4, B)'],
  ['D_112',        '6112 앞 (키 5)'],
  ['D_113',        '6113 앞 (키 6)'],
  ['D_119',        '6119 · 6122 앞 (키 7, 8)'],
  ['D_127',        '6127 앞 (키 9)'],
  ['D_141',        '6141 앞 (키 0)'],
  ['D_중앙엘리베이터', '중앙 엘리베이터 앞 (키 C)'],
  ['D_130',        '6130 앞 (가운데 세로 복도)'],
  ['T_E',          '북동 엘리베이터 앞 (북쪽 복도 끝)'],
  ['B_E',          '남쪽 복도 남동계단 갈림길'],
];

// 6층 안내도에 적힌 실 이름 (다른 층은 번호만 표시)
const DESCRIPTIONS = {
  6: {
    '6103': '네트워크 컴퓨팅시스템 구조 연구실', '6105': '소프트웨어 구조 연구실',
    '6107': '로봇 인공지능 연구실', '6109': '융합소프트웨어교육원 프로젝트 연구실',
    '6112': '차세대무선최적화연구실', '6113': '빅데이터랩', '6115': 'μ-Cloud Computing Lab.',
    '6119': '컴퓨터·AI학부 실습실4', '6120': '교수연구실', '6122': '정보통신공학 실습실3',
    '6127': '로보틱스 및 인공지능 주행 연구실', '6128': 'DIS&AE Lab.', '6130': '컴퓨터 네트워크 공학연구실',
    '6132': '초고속통신망 연구실', '6134': '디지털미디어 연구실', '6141': '강의실', '6144': '강의실',
    '6147': '강의실', '6155': '제품공학 실습실',
  },
};

// ---------- 복도 (층마다 동일) ----------
const P = {
  W_N: [200, 280], W_M: [200, 640], W_S: [200, 1010],
  C_N: [355, 285], C_S: [355, 1010],
  T_E: [830, 280], B_EV: [285, 1010], B_E: [790, 1010], SE_C: [790, 1100],
  LINK: [850, 1040], W2_S: [1010, 1040], W2_SE: [1480, 1040],
  W2_N: [1010, 265], W2_NW: [890, 265], W2_NE: [1190, 265],
  W3_A: [1524, 1048], W3_B: [1954, 498],
};
const CORRIDORS = [
  ['W_N', 'W_M', 'W_S'], ['C_N', 'C_S'], ['W_N', 'C_N', 'T_E'],
  ['W_S', 'B_EV', 'C_S', 'B_E'], ['B_E', 'SE_C'],
  ['B_E', 'LINK', 'W2_S', 'W2_SE', 'W3_A', 'W3_B'],
  ['W2_S', 'W2_N'], ['W2_NW', 'W2_N', 'W2_NE'],
];

// ---------- 방 (번호는 뒤 3자리만, 앞에 층 번호가 붙음) ----------
// [이름, x, y, w, h, 종류, 출입구 힌트(복도 쪽 좌표, 생략하면 방 중심)]
const R = (n, x, y, w, h, type = 'room', hint = null, vlink = null) => ({ n, x, y, w, h, type, hint, vlink });
const ROOMS = [
  // 1구역 (x100번대)
  R('113', 220, 90, 145, 160), R('115', 365, 90, 120, 160), R('119', 485, 90, 280, 170), R('120', 765, 95, 100, 120),
  R('112', 50, 330, 135, 180), R('109', 55, 510, 130, 125), R('107', 58, 635, 127, 115),
  R('105', 62, 750, 123, 115), R('103', 65, 865, 120, 120), R('101', 100, 990, 65, 90),
  R('147', 170, 1025, 185, 195), R('144', 355, 1025, 200, 200), R('141', 555, 1030, 205, 200),
  R('127', 370, 365, 125, 160), R('122', 495, 365, 275, 160), R('128', 375, 525, 120, 120),
  R('130', 380, 645, 115, 115), R('132', 385, 760, 110, 115), R('134', 385, 875, 110, 110),
  R('155', 210, 355, 120, 55),
  R('여자화장실', 215, 470, 110, 115, 'wc', [200, 527]),
  R('남자화장실', 220, 620, 105, 110, 'wc', [200, 675]),
  R('중앙계단', 230, 735, 55, 95, 'stair', [200, 800], 'S1'),
  R('중앙 엘리베이터', 240, 865, 90, 55, 'ev', [285, 1010], 'E1'),
  R('북동 엘리베이터', 755, 325, 50, 50, 'ev', [780, 280], 'E2'),
  R('북동계단', 808, 330, 55, 100, 'stair', [830, 280], 'S2'),
  R('남동계단', 765, 1110, 85, 120, 'stair', [790, 1100], 'S3'),
  R('', 500, 530, 350, 470, 'void'),
  // 2구역 (x200번대)
  ...['210', '211', '212', '213', '214'].map((n, i) => R(n, 880 + i * 65, 105, 65, 135)),
  ...['209', '208', '207', '206', '205', '204', '203', '202', '201'].map((n, i) =>
    R(n, 855, 500 + i * 55.5, 105, 55.5, 'room', [1010, 528 + i * 55.5])),
  ...['215', '216', '217', '218', '219', '220', '221', '222', '223', '224'].map((n, i) =>
    R(n, 1065, 300 + i * 59, 115, 59, 'room', [1010, 330 + i * 59])),
  ...['225', '226', '227', '228', '229'].map((n, i) => R(n, 1145 + i * 59, 900, 59, 100)),
  ...['240', '239', '238', '237', '236', '235', '234', '233', '232', '231', '230'].map((n, i) =>
    R(n, 845 + i * 58, 1080, 58, 80)),
  R('2구역 계단(중앙)', 1020, 895, 85, 65, 'stair', [1010, 930], 'S4'),
  R('2구역 계단(북)', 880, 285, 120, 200, 'stair', [1010, 360], 'S5'),
  R('320', 1490, 1095, 70, 55),
];

// 3구역 (x300번대) — 비스듬한 동
const S = P.W3_A, E = P.W3_B;
const L = Math.hypot(E[0] - S[0], E[1] - S[1]);
const d = [(E[0] - S[0]) / L, (E[1] - S[1]) / L], nrm = [-d[1], d[0]];
const ANGLE = Math.atan2(d[1], d[0]);
const along = (s, off) => [S[0] + d[0] * s + nrm[0] * off, S[1] + d[1] * s + nrm[1] * off];
const ROT = [];
for (let i = 0; i < 10; i++) ROT.push({ n: String(301 + i), c: along(88 + 61 * i, -90), w: 58, h: 80, type: 'room' });
for (let i = 0; i < 9; i++) ROT.push({ n: String(319 - i), c: along(90 + 59 * i, 90), w: 56, h: 80, type: 'room' });
ROT.push({ n: '3구역 계단', c: along(26, 90), w: 50, h: 80, type: 'stair', vlink: 'S6' });

// ---------- 생성 ----------
function project(pt, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * vx + (pt[1] - a[1]) * vy) / (vx * vx + vy * vy)));
  const q = [a[0] + vx * t, a[1] + vy * t];
  return { t, q, dist: Math.hypot(pt[0] - q[0], pt[1] - q[1]) };
}

const map = { building: '신공학관', pxPerM: PX_PER_M, canvas: { w: 2000, h: 1260 },
              floors: [], nodes: [], edges: [], stations: {}, stationNotes: {}, destinations: [] };
const vlinks = {};

for (const f of FLOORS) {
  const id = k => `${f}F_${k}`;
  const floor = { id: f, rooms: [] };
  for (const [k, [x, y]] of Object.entries(P)) map.nodes.push({ id: id(k), floor: f, x, y });

  // 세그먼트 목록 + 각 세그먼트에 붙는 출입구
  const segs = [];
  for (const line of CORRIDORS)
    for (let i = 1; i < line.length; i++) segs.push({ a: line[i - 1], b: line[i], doors: [] });

  const allRooms = [
    ...ROOMS.map(r => ({ ...r, cx: r.x + r.w / 2, cy: r.y + r.h / 2, angle: 0 })),
    ...ROT.map(r => ({ ...r, cx: r.c[0], cy: r.c[1], angle: ANGLE })),
  ];
  for (const r of allRooms) {
    const isNum = /^\d+$/.test(r.n);
    const name = isNum ? `${f}${r.n}` : r.n;
    floor.rooms.push({ name, cx: +r.cx.toFixed(1), cy: +r.cy.toFixed(1), w: r.w, h: r.h,
                       angle: +r.angle.toFixed(4), type: r.type });
    if (r.type === 'void') continue;

    const pt = r.hint ?? [r.cx, r.cy];
    let best = null;
    for (const s of segs) {
      const pr = project(pt, P[s.a], P[s.b]);
      if (!best || pr.dist < best.pr.dist) best = { s, pr };
    }
    const doorId = id(`D_${isNum ? r.n : r.n.replace(/\s/g, '')}`);
    map.nodes.push({ id: doorId, floor: f, x: +best.pr.q[0].toFixed(1), y: +best.pr.q[1].toFixed(1), label: name });
    best.s.doors.push({ t: best.pr.t, id: doorId });

    if (r.vlink) (vlinks[r.vlink] ||= []).push({ f, id: doorId, cost: r.type === 'ev' ? EV_COST : STAIR_COST });
    if (r.type === 'room' || r.type === 'wc') {
      const desc = isNum && DESCRIPTIONS[f]?.[name];
      const text = r.type === 'wc' ? `${f}층 ${name}` : desc ? `${name} ${desc}` : name;
      map.destinations.push({ name: text, room: name, node: doorId, floor: f });
    }
  }
  // 세그먼트를 출입구 순서대로 쪼개서 연결
  for (const s of segs) {
    const chain = [id(s.a), ...s.doors.sort((x, y) => x.t - y.t).map(x => x.id), id(s.b)];
    for (let i = 1; i < chain.length; i++) if (chain[i] !== chain[i - 1]) map.edges.push([chain[i - 1], chain[i]]);
  }
  map.floors.push(floor);
}

// 층 사이 연결 (계단/엘리베이터)
for (const list of Object.values(vlinks)) {
  list.sort((a, b) => a.f - b.f);
  for (let i = 1; i < list.length; i++)
    map.edges.push([list[i - 1].id, list[i].id, list[i].cost * (list[i].f - list[i - 1].f)]);
}

// 스테이션 배치 (STATION_FLOOR 층에만)
let no = 1;
if (FLOORS.includes(STATION_FLOOR))
  for (const [k, note] of STATION_SPOTS) {
    const sid = `STATION_${String(no++).padStart(2, '0')}`;
    const node = `${STATION_FLOOR}F_${k}`;
    if (!map.nodes.some(n => n.id === node)) throw new Error(`스테이션 자리 ${node}가 지도에 없음`);
    map.stations[sid] = node;
    map.stationNotes[sid] = `${STATION_FLOOR}층 ${note}`;
  }

map.destinations.sort((a, b) => a.floor - b.floor || a.room.localeCompare(b.room, 'ko', { numeric: true }));
fs.writeFileSync(path.join(__dirname, 'public', 'map.json'), JSON.stringify(map, null, 1));
console.log(`map.json 생성: ${FLOORS.join(', ')}층 / 노드 ${map.nodes.length}개 / 목적지 ${map.destinations.length}개`);
console.log('ESP32 배치:');
for (const [sid, note] of Object.entries(map.stationNotes)) console.log(`  ${sid} → ${note}`);
