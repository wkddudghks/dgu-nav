// 동국대 신공학관 다층 실내 내비게이션 서버
// 실행: npm install → node server.js → http://localhost:3001  (폰: http://<노트북IP>:3001)
//
// 위치 판단 방식: "가장 신호가 센 스테이션 = 현재 위치"
//  - 삼각측량보다 복도 환경에서 훨씬 안정적이고, 층도 자동으로 판별됨
//  - 히스테리시스: 새 스테이션이 지금 스테이션보다 SWITCH_DB 이상 세야 위치를 바꿈 (깜빡임 방지)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3001;   // 클라우드(Render)는 PORT를 정해 줌

// ===== 쓰기 권한 =====
// 클라우드에서는 DEVICE_KEY(비밀 키)를 아는 기기만 위치 데이터/설정을 보낼 수 있음
// 노트북에서는 키 없이 내부망 요청만 허용 (인터넷 공유 링크로 들어온 요청은 거부)
const DEVICE_KEY = process.env.DEVICE_KEY || '';
function canWrite(req, res, next) {
  if (DEVICE_KEY) return req.headers['x-device-key'] === DEVICE_KEY ? next() : res.sendStatus(401);
  return req.headers['cf-connecting-ip'] ? res.sendStatus(403) : next();
}
const WINDOW = 5;       // 이동평균에 쓸 최근 측정 개수
const STALE_MS = 4000;  // 이 시간 동안 안 들어온 스테이션은 무시
const SWITCH_DB = 4;    // 위치를 바꾸려면 몇 dB 더 세야 하는지
const MIN_RSSI = -90;   // 이보다 약하면 "근처 아님"으로 봄
const MAX_STATIONS = 20; // STATION_01 ~ STATION_20 까지 받음
const isStationId = id => typeof id === 'string' && /^STATION_\d{2}$/.test(id) && +id.slice(8) >= 1 && +id.slice(8) <= MAX_STATIONS;
const { solveLayout, median, label } = require('./selfloc');
const { planRoute, planRoomRoute } = require('./carroute');

const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'map.json'), 'utf8'));
const nodeById = Object.fromEntries(map.nodes.map(n => [n.id, n]));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));   // 첫 화면 = 방 위치 측정 (신공학관 지도는 /index.html)
app.use(express.static(path.join(__dirname, 'public')));

const history = {};   // station -> 최근 RSSI
const lastSeen = {};
let current = null;   // 현재 판단된 스테이션 ID

function snapshot() {
  const now = Date.now();
  const status = {};
  for (const id of new Set([...Object.keys(map.stations), ...Object.keys(room.stations), ...Object.keys(lastSeen)])) {
    const fresh = lastSeen[id] && now - lastSeen[id] < STALE_MS;
    status[id] = fresh ? Math.round(history[id].reduce((a, b) => a + b, 0) / history[id].length) : null;
  }
  return status;
}

function decide(status) {
  const alive = Object.entries(status).filter(([id, r]) => map.stations[id] && r !== null && r > MIN_RSSI);   // 층 지도에 등록된 스테이션만
  if (!alive.length) { current = null; return; }
  alive.sort((a, b) => b[1] - a[1]);
  const [bestId, bestRssi] = alive[0];
  const curRssi = current ? status[current] : null;
  if (curRssi === null || curRssi <= MIN_RSSI || bestRssi - curRssi >= SWITCH_DB) current = bestId;
}

// ===== 복도 보정 모드 =====
// 설정기(버튼 4개 + LCD)로 입력한 "기준점에서 각 스테이션까지 거리(m)"를 써서
// 폰이 복도 위 몇 m 지점에 있는지 추정합니다 (RSSI 가중 평균).
const TX_POWER = -59;   // 1m 거리에서 잰 RSSI (설정기에서 측정해 바꿀 수 있음)
const N_EXP = 2.5;      // 경로 손실 지수 (복도 2.5~3)
const CORRIDOR_FILE = path.join(__dirname, 'corridor.json');
const CORRIDOR_IDS = ['STATION_01', 'STATION_02', 'STATION_03', 'STATION_04'];
let corridor = { positions: { STATION_01: 0, STATION_02: 5, STATION_03: 10, STATION_04: 15 } };
try { corridor = JSON.parse(fs.readFileSync(CORRIDOR_FILE, 'utf8')); } catch (e) {}

function rssiToMeters(rssi) { return Math.pow(10, (TX_POWER - rssi) / (10 * N_EXP)); }

function estimateCorridor(status) {
  let sw = 0, sx = 0;
  const parts = [];
  for (const id of CORRIDOR_IDS) {
    const rssi = status[id];
    if (rssi == null || corridor.positions[id] == null) continue;
    const d = Math.max(rssiToMeters(rssi), 0.5);
    const w = 1 / (d * d);                 // 가까운(신호 센) 스테이션일수록 큰 가중치
    sw += w; sx += w * corridor.positions[id];
    parts.push({ id, rssi, d: +d.toFixed(2) });
  }
  return { estimate: sw ? +(sx / sw).toFixed(2) : null, parts };
}

// ===== 네모 방(2D) 모드 =====
// 방 크기와 스테이션 위치(x, y, m 단위, 10cm 단위)를 room.html에서 끌어서 정함
// 폰 위치는 "각 스테이션까지 추정 거리"에 가장 잘 맞는 점을 방 안에서 5cm 간격으로 찾아서 구함
const ROOM_FILE = path.join(__dirname, 'room.json');
let room = {
  width: 5, height: 4,
  stations: { STATION_01: { x: 0.5, y: 0.5 }, STATION_02: { x: 4.5, y: 0.5 },
              STATION_03: { x: 4.5, y: 3.5 }, STATION_04: { x: 0.5, y: 3.5 } },
};
try { room = JSON.parse(fs.readFileSync(ROOM_FILE, 'utf8')); } catch (e) {}
const r1 = v => Math.round(v * 10) / 10;   // 10cm 단위로 맞추기
// 네모방에서 쓰는 스테이션 수 (S1 ~ S4). 폰 핫스팟에 붙는 기기가 최대 5개라 스테이션 4개 + 자동차 1개
//  이 번호를 넘는 스테이션은 네모방 배치·위치 계산에서 빠짐. 위치가 없는 스테이션은 빈 자리에 고르게 놓음
const ROOM_STATIONS = 4;
const isRoomStation = id => isStationId(id) && +id.slice(8) <= ROOM_STATIONS;
function fillRoomStations() {
  for (const id of Object.keys(room.stations)) if (!isRoomStation(id)) delete room.stations[id];   // S5 이후는 지움
  const ids = Array.from({ length: ROOM_STATIONS }, (_, i) => `STATION_${String(i + 1).padStart(2, '0')}`);
  const missing = ids.filter(id => !room.stations[id]);
  if (!missing.length) return;
  // 이미 놓인 스테이션들과 가장 멀리 떨어진 빈 자리를 하나씩 골라 채움 (겹치지 않게 고르게 퍼짐)
  const W = room.width, H = room.height, m = Math.min(0.5, W / 4, H / 4);
  const placed = Object.values(room.stations).map(p => [p.x, p.y]);
  const cand = [];
  for (let x = m; x <= W - m + 1e-9; x += 0.1) for (let y = m; y <= H - m + 1e-9; y += 0.1) cand.push([r1(x), r1(y)]);
  for (const id of missing) {
    let best = cand[0], bd = -1;
    for (const c of cand) {
      const d = placed.length ? Math.min(...placed.map(p => Math.hypot(p[0] - c[0], p[1] - c[1]))) : 0;
      if (d > bd) { bd = d; best = c; }
    }
    placed.push(best);
    room.stations[id] = { x: best[0], y: best[1] };
  }
}
fillRoomStations();
let roomSmooth = null;

function roomFit(status) {
  const parts = [];
  for (const [id, s] of Object.entries(room.stations)) {
    if (status[id] == null) continue;
    const d = rssiToMeters(status[id]);
    parts.push({ id, rssi: status[id], d: +d.toFixed(2), x: s.x, y: s.y });
  }
  if (!parts.length) return { best: null, parts };
  let best = null, bestErr = Infinity;
  const STEP = 0.05;
  for (let x = 0; x <= room.width + 1e-9; x += STEP)
    for (let y = 0; y <= room.height + 1e-9; y += STEP) {
      let err = 0;
      for (const p of parts) {
        const diff = Math.hypot(x - p.x, y - p.y) - p.d;
        err += diff * diff / Math.max(p.d, 0.3) ** 2;   // 가까운(믿을 만한) 스테이션에 더 큰 가중치
      }
      if (err < bestErr) { bestErr = err; best = { x, y }; }
    }
  return { best, parts };
}
function estimateRoom(status) {
  const { best, parts } = roomFit(status);
  if (!best) { roomSmooth = null; return { estimate: null, parts }; }
  // 화면에서 덜 튀도록 이전 값과 섞기
  roomSmooth = roomSmooth ? { x: roomSmooth.x * 0.5 + best.x * 0.5, y: roomSmooth.y * 0.5 + best.y * 0.5 } : best;
  return { estimate: { x: +roomSmooth.x.toFixed(2), y: +roomSmooth.y.toFixed(2) }, parts };
}

let lastRoom = { estimate: null, parts: [] };
// ===== 로봇카 실험 기록 =====
// ESP32(car_brain.ino)가 주행이 끝날 때마다 한 줄씩 보냄
//  "시행,목적지키,경로,결과,모드,t=63.2,ep=3,blk=12.4,minf=7,touch=1,esc=0"
const CARLOG_FILE = path.join(__dirname, 'carlog.json');
let carlog = [];
try { carlog = JSON.parse(fs.readFileSync(CARLOG_FILE, 'utf8')); } catch (e) {}
function parseCarLine(line) {
  const p = String(line).split(',');
  const kv = Object.fromEntries(p.slice(5).map(s => s.split('=')).filter(x => x.length === 2).map(([k, v]) => [k, +v]));
  return { at: new Date().toISOString(), trial: +p[0], dest: p[1], route: p[2], result: p[3], mode: p[4],
           time: kv.t, episodes: kv.ep, blocked: kv.blk, minFront: kv.minf, touches: kv.touch, escapes: kv.esc };
}
app.post('/carlog', canWrite, (req, res) => {
  const line = req.body?.line;
  if (!line || String(line).length > 200) return res.sendStatus(400);
  const row = parseCarLine(line);
  carlog.push(row);
  try { fs.writeFileSync(CARLOG_FILE, JSON.stringify(carlog, null, 1)); } catch (e) {}
  console.log('[로봇 기록]', row.mode, row.result, row.time + '초', '장애물', row.episodes);
  io.emit('carlog', row);
  res.json(row);
});
app.get('/carlog.json', (req, res) => res.json(carlog));
app.get('/carlog.csv', (req, res) => {
  const head = 'at,trial,dest,route,result,mode,time_s,episodes,blocked_s,min_front_cm,touches,escapes';
  const rows = carlog.map(r => [r.at, r.trial, r.dest, r.route, r.result, r.mode, r.time, r.episodes, r.blocked, r.minFront, r.touches, r.escapes].join(','));
  res.type('text/csv').send('﻿' + [head, ...rows].join('\n'));
});
app.post('/carlog/clear', canWrite, (req, res) => {
  carlog = []; try { fs.writeFileSync(CARLOG_FILE, '[]'); } catch (e) {}
  io.emit('carlog', null); res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true, keyRequired: !!DEVICE_KEY, stations: Object.fromEntries(Object.keys(lastSeen).map(id => [id, Math.round((Date.now() - lastSeen[id]) / 1000) + 's 전'])) }));
app.get('/room', (req, res) => res.json({ ...room, ...lastRoom }));
app.post('/room', canWrite, (req, res) => {
  const b = req.body || {};
  const w = +b.width, h = +b.height;
  if (!(w >= 0.5 && w <= 50 && h >= 0.5 && h <= 50) || !b.stations) return res.sendStatus(400);
  const stations = {};
  for (const [id, s] of Object.entries(b.stations)) {
    if (!isStationId(id)) return res.sendStatus(400);
    if (!isRoomStation(id)) continue;                 // S5 이후는 저장 안 함
    if (!s || !Number.isFinite(+s.x) || !Number.isFinite(+s.y)) return res.sendStatus(400);
    stations[id] = { x: r1(Math.min(Math.max(+s.x, 0), w)), y: r1(Math.min(Math.max(+s.y, 0), h)) };
  }
  room = { width: r1(w), height: r1(h), stations };
  try { fs.writeFileSync(ROOM_FILE, JSON.stringify(room, null, 1)); } catch (e) {}
  console.log(`[방] ${room.width}m x ${room.height}m  ` +
    Object.entries(stations).map(([id, s]) => `${label(id)}(${s.x}, ${s.y})`).join(' '));
  roomSmooth = null;
  broadcast();
  res.json({ ...room, ...lastRoom });
});

// ===== 스테이션 위치 자동 추정 =====
// 스테이션마다 자기 비콘(Major 7777, Minor = 번호)을 내보내고, 다른 스테이션 신호 세기를 재서 /peers로 보냄
// 서버는 쌍마다 최근 값의 중앙값 → 거리 → selfloc.js로 2D 배치를 계산해 방 화면의 스테이션 위치로 씀
const PEER_FILE = path.join(__dirname, 'peers.json');
const PEER_WINDOW = 30;        // 쌍마다 최근 몇 개를 쓸지
const PEER_STALE_MS = 60000;   // 1분 넘게 안 들어온 쌍은 버림
const PEER_MIN_SAMPLES = 5;    // 이만큼 모여야 그 쌍을 씀
const PEER_MIN_RSSI = -92;
let peerCfg = { tx: -59, n: 2.5, auto: false, ref: null };   // tx: 스테이션끼리 1m에서의 RSSI, ref: 줄자로 잰 기준 거리 {a, b, d}
try { peerCfg = { ...peerCfg, ...JSON.parse(fs.readFileSync(PEER_FILE, 'utf8')) }; } catch (e) {}
const savePeerCfg = () => { try { fs.writeFileSync(PEER_FILE, JSON.stringify(peerCfg, null, 1)); } catch (e) {} };
const peerRaw = {};            // "STATION_01|STATION_02" (작은 번호 먼저) -> { s: [rssi...], t }
let lastLayout = null;
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function peerLinks() {
  const now = Date.now(), out = [];
  for (const [k, v] of Object.entries(peerRaw)) {
    if (now - v.t > PEER_STALE_MS || v.s.length < PEER_MIN_SAMPLES) continue;
    const rssi = median(v.s);
    if (rssi < PEER_MIN_RSSI) continue;
    const [a, b] = k.split('|');
    if (!isRoomStation(a) || !isRoomStation(b)) continue;   // 네모방 스테이션(S1~S4)끼리만
    out.push({ a, b, rssi: Math.round(rssi), n: v.s.length, d: +rssiToDistPeer(rssi).toFixed(2) });
  }
  return out;
}
const rssiToDistPeer = r => Math.pow(10, (peerCfg.tx - r) / (10 * peerCfg.n));
function peerSummary() {
  const links = peerLinks();
  return { links, tx: peerCfg.tx, n: peerCfg.n, auto: peerCfg.auto, ref: peerCfg.ref, last: lastLayout };
}

app.post('/peers', canWrite, (req, res) => {
  const { station, peers } = req.body || {};
  if (!isStationId(station) || !peers || typeof peers !== 'object') return res.sendStatus(400);
  const now = Date.now();
  for (const [k, r] of Object.entries(peers)) {
    const other = /^\d+$/.test(k) ? `STATION_${String(+k).padStart(2, '0')}` : k;   // "3" 또는 "STATION_03"
    if (!isStationId(other) || other === station || typeof r !== 'number' || r > 0 || r < -110) continue;
    const key = pairKey(station, other);
    const v = peerRaw[key] || (peerRaw[key] = { s: [], t: 0 });
    v.s.push(r); if (v.s.length > PEER_WINDOW) v.s.shift(); v.t = now;   // A가 들은 값과 B가 들은 값을 함께 모음
  }
  res.json({ ok: true });
});
app.get('/peers', (req, res) => res.json(peerSummary()));

// 자동 배치 계산 → 방 화면 스테이션 위치로 적용
function autoLayout() {
  const links = peerLinks();
  const ids = [...new Set(links.flatMap(l => [l.a, l.b]))].sort();
  if (ids.length < 3) return { error: `스테이션끼리 잰 신호가 부족해요 (연결된 스테이션 ${ids.length}개, 3개 이상 필요)` };
  const r = solveLayout(ids, links, { tx: peerCfg.tx, n: peerCfg.n, prev: room.stations, ref: peerCfg.ref });
  room = { width: r.width, height: r.height, stations: r.positions };
  fillRoomStations();   // 신호가 안 잡힌 스테이션은 빈 자리에
  try { fs.writeFileSync(ROOM_FILE, JSON.stringify(room, null, 1)); } catch (e) {}
  roomSmooth = null;
  lastLayout = { at: new Date().toISOString(), stations: ids.length, pairs: r.pairs, rms: r.rms, scale: r.scale, ref: peerCfg.ref, perStation: r.perStation, warnings: r.warnings };
  console.log(`[자동 배치] 스테이션 ${ids.length}개, 쌍 ${r.pairs}개, 거리 잔차 ${r.rms}m` + (r.warnings.length ? ' · ' + r.warnings.join(' / ') : ''));
  return { ok: true, ...lastLayout };
}
// body: { mode: 'once' | 'on' | 'off', ref: { a, b, d } | 'clear' }
//  ref = 두 스테이션 사이를 줄자로 잰 거리(m) → 배치 전체 크기를 그 거리에 맞춤 (저장돼서 다음 배치에도 쓰임)
app.post('/room/auto', canWrite, (req, res) => {
  const b = req.body || {};
  if (b.ref === 'clear') { peerCfg.ref = null; savePeerCfg(); }
  else if (b.ref) {
    const { a, b: bb, d } = b.ref;
    if (!isStationId(a) || !isStationId(bb) || a === bb || !(+d > 0.2 && +d < 50)) return res.status(400).json({ error: '기준 거리 값이 잘못됐어요' });
    peerCfg.ref = { a, b: bb, d: +d };
    savePeerCfg();
    console.log(`[자동 배치] 기준 거리 ${label(a)}–${label(bb)} = ${d}m`);
  }
  if (b.mode === 'on' || b.mode === 'off') { peerCfg.auto = b.mode === 'on'; savePeerCfg(); }
  const out = b.mode === 'off' ? { ok: true } : autoLayout();
  broadcast();
  res.status(out.error ? 409 : 200).json({ ...out, auto: peerCfg.auto, tx: peerCfg.tx, room });
});
setInterval(() => { if (peerCfg.auto) { const r = autoLayout(); if (!r.error) broadcast(); } }, 10000);

// ===== 길잡이 로봇 (차 위 ESP32 = STATION_A) =====
// 차가 벽 스테이션 13개의 비콘(Major 7777)을 듣고 번호별 RSSI를 보냄 → 가장 센 스테이션 자리 = 차 위치
// 키패드로 목적지·차 방향을 고르면 /car/route가 지도 최단 경로를 우노 명령(carroute.js)으로 바꿔 줌
const CAR_STALE_MS = 15000;
const lastStatusOf = id => snapshot()[id] ?? null;
let car = null;   // { id, near, node, rssi, heading, state, dest, at, route }
function carNearest(rssi) {
  let best = null;
  for (const [k, r] of Object.entries(rssi || {})) {
    const sid = /^\d+$/.test(k) ? `STATION_${String(+k).padStart(2, '0')}` : k;
    if (!map.stations[sid] || typeof r !== 'number' || r < -95) continue;
    if (!best || r > best.r) best = { sid, r };
  }
  return best;
}
// 차가 들은 신호(번호 → RSSI)로 네모방 안 차 위치 추정 (폰 위치 추정과 같은 방법)
let carRoomSmooth = null;
function carRoomPos(rssi) {
  const st = {};
  for (const [k, r] of Object.entries(rssi || {})) {
    const sid = /^\d+$/.test(k) ? `STATION_${String(+k).padStart(2, '0')}` : k;
    if (room.stations[sid] && typeof r === 'number' && r >= -95) st[sid] = r;
  }
  const { best, parts } = roomFit(st);
  if (!best) { carRoomSmooth = null; return null; }
  carRoomSmooth = carRoomSmooth ? { x: carRoomSmooth.x * 0.5 + best.x * 0.5, y: carRoomSmooth.y * 0.5 + best.y * 0.5 } : best;
  return { x: +carRoomSmooth.x.toFixed(2), y: +carRoomSmooth.y.toFixed(2), n: parts.length };
}
function carUpdate(b) {
  let near = carNearest(b.rssi);
  // 차가 스테이션 신호를 못 들어도, 차가 비콘(123/123)을 쏘는 중이면 스테이션들이 잰 위치를 씀
  //  (차가 비콘을 안 쏘면 그 위치는 폰 위치라 쓰지 않음 — 차 = 움직이는 스테이션)
  if (!near && b.beacon === true && current && map.stations[current]) near = { sid: current, r: lastStatusOf(current), via: 'stations' };
  car = { ...(car || {}), id: b.id || 'STATION_A', rssi: b.rssi || {}, heading: b.heading || car?.heading || null,
          state: b.state || car?.state || null, dest: b.dest ?? car?.dest ?? null, at: Date.now(),
          near: near ? near.sid : null, node: near ? map.stations[near.sid] : null,
          mode: b.mode || car?.mode || 'map', roomPos: carRoomPos(b.rssi) };
  return near;
}
// 네모방 화면의 버튼 → 차에 보낼 명령을 맡아 두었다가, 차가 다음 위치 보고(/car) 때 받아 감
let carCmd = null;   // { go: "STATION_05", heading: "N" } | { stop: true }, at
app.post('/car/go', canWrite, (req, res) => {
  const b = req.body || {};
  if (!car || Date.now() - car.at > CAR_STALE_MS) return res.status(409).json({ error: '차가 연결돼 있지 않아요 (차 ESP32 전원·와이파이 확인)' });
  if (b.stop) { carCmd = { stop: true, at: Date.now() }; return res.json({ ok: true }); }
  const n = parseInt(String(b.to ?? '').replace(/\D/g, ''), 10);
  const sid = `STATION_${String(n).padStart(2, '0')}`;
  if (!room.stations[sid]) return res.status(400).json({ error: `네모방에 ${sid}가 없어요` });
  if (!['N', 'E', 'S', 'W'].includes(b.heading)) return res.status(400).json({ error: '방향은 N, E, S, W 중 하나' });
  carCmd = { go: sid, heading: b.heading, at: Date.now() };
  console.log(`[로봇·네모방] 화면에서 ${label(sid)}로 가라는 명령 (차 방향 ${b.heading})`);
  res.json({ ok: true });
});
app.post('/car', canWrite, (req, res) => {
  const near = carUpdate(req.body || {});
  broadcast();
  const out = { ok: true, near: near?.sid || null, node: car.node, roomPos: car.roomPos };
  if (carCmd && Date.now() - carCmd.at < 30000) {          // 30초 넘은 명령은 버림
    if (carCmd.stop) out.cmd = 'STOP'; else { out.cmd = 'GO'; out.go = String(parseInt(carCmd.go.slice(8), 10)); out.goHeading = carCmd.heading; }
  }
  carCmd = null;
  res.json(out);
});
app.get('/car', (req, res) => res.json(car && Date.now() - car.at < CAR_STALE_MS ? car : null));
// body: { rssi: {"1": -60, ...}, heading: 'N'|'E'|'S'|'W', to: "D_119" | "6119" | "6F_D_119", id? }
app.post('/car/route', canWrite, (req, res) => {
  const b = req.body || {};
  if (b.mode === 'room') return roomRoute(b, res);
  const near = carUpdate({ ...b, state: 'ROUTING' });
  if (!near) return res.status(409).json({ error: '차가 들은 스테이션 신호가 없어요 (스테이션 가까이로 옮기거나 스테이션 전원 확인)' });
  let to = String(b.to || '').replace(/\s/g, '');
  if (/^\d{4}$/.test(to)) to = `6F_D_${to.slice(1)}`;
  else if (!to.startsWith('6F_')) to = `6F_${to.startsWith('D_') ? to : 'D_' + to}`;
  const r = planRoute(map, car.node, to, b.heading);
  if (r.error) return res.status(400).json(r);
  car.route = { to, route: r.route, steps: r.steps, meters: r.meters, path: r.path, endHeading: r.endHeading };
  car.dest = to;
  console.log(`[로봇] ${label(near.sid)} 근처(${near.r}dBm), ${b.heading} 방향 → ${to}: ${r.route} (${r.meters}m)`);
  broadcast();
  res.json({ ok: true, from: car.node, near: near.sid, ...car.route });
});

// 네모방: 목적지 = 스테이션 (to: "5" | "S5" | "STATION_05"), 차 위치 = 차가 들은 스테이션 신호로 추정
function roomRoute(b, res) {
  carUpdate({ ...b, state: 'ROUTING', mode: 'room' });
  const n = parseInt(String(b.to || '').replace(/\D/g, ''), 10);
  const sid = `STATION_${String(n).padStart(2, '0')}`;
  const target = room.stations[sid];
  if (!target) return res.status(400).json({ error: `네모방에 ${sid}가 없어요` });
  const from = car.roomPos;
  if (!from) return res.status(409).json({ error: '차가 들은 스테이션 신호가 없어요 (스테이션 전원 확인)' });
  const r = planRoomRoute(from, target, b.heading, 0.3);
  if (r.error) return res.status(400).json(r);
  const warn = from.n < 3 ? `스테이션 ${from.n}개만 들려서 차 위치가 부정확할 수 있어요` : null;
  car.route = { to: sid, route: r.route, steps: r.steps, meters: r.meters, roomPath: r.path, endHeading: r.endHeading };
  car.dest = sid;
  console.log(`[로봇·네모방] (${from.x}, ${from.y})m, ${b.heading} 방향 → ${label(sid)}: ${r.route || '이미 도착'} (${r.meters}m)${warn ? ' ⚠ ' + warn : ''}`);
  broadcast();
  res.json({ ok: true, from, near: label(sid), warn, ...car.route });
}

let lastCorridor = { estimate: null, parts: [] };
function broadcast() {
  const status = snapshot();
  decide(status);
  lastCorridor = estimateCorridor(status);
  lastRoom = estimateRoom(status);
  const nodeId = current ? map.stations[current] : null;
  io.emit('update', {
    status,
    dist: Object.fromEntries(Object.entries(status).map(([id, r]) => [id, r == null ? null : +rssiToMeters(r).toFixed(1)])),
    station: current,
    node: nodeId,
    floor: nodeId ? nodeById[nodeId].floor : null,
    corridor: { positions: corridor.positions, ...lastCorridor },
    room: { ...room, ...lastRoom },
    peers: peerSummary(),
    car: car && Date.now() - car.at < CAR_STALE_MS ? car : null,
  });
}


// 설정기가 읽어가는 현재 값
app.get('/corridor', (req, res) => {
  res.json({ positions: corridor.positions, estimate: lastCorridor.estimate, nearest: current });
});

// 설정기가 버튼을 누를 때마다 보내는 값 (내부망에서만)
app.post('/corridor', canWrite, (req, res) => {
  const p = req.body?.positions;
  if (!p || !CORRIDOR_IDS.every(id => Number.isFinite(p[id]) && p[id] >= 0 && p[id] <= 200)) return res.sendStatus(400);
  corridor.positions = Object.fromEntries(CORRIDOR_IDS.map(id => [id, Math.round(p[id])]));
  try { fs.writeFileSync(CORRIDOR_FILE, JSON.stringify(corridor, null, 1)); } catch (e) {}
  console.log('[보정] 스테이션 위치(m):', CORRIDOR_IDS.map(id => `${id.slice(-2)}=${corridor.positions[id]}`).join(' '));
  broadcast();
  res.json({ positions: corridor.positions, estimate: lastCorridor.estimate, nearest: current });
});

app.post('/rssi', canWrite, (req, res) => {
  const { station, rssi } = req.body || {};
  if (!isStationId(station) || typeof rssi !== 'number') return res.sendStatus(400);
  history[station] = (history[station] || []).concat(rssi).slice(-WINDOW);
  lastSeen[station] = Date.now();
  console.log(`[수신] ${station} (${map.stations[station] || '방'}): ${rssi}dBm (약 ${rssiToMeters(rssi).toFixed(1)}m)`);
  broadcast();
  // LCD 스테이션용 응답: 이 스테이션이 지금 가장 가까운지 알려줌 (기존 ESP32 코드는 무시해도 됨)
  const bestNode = current ? map.stations[current] : null;
  res.json({ here: current === station, best: current, floor: bestNode ? nodeById[bestNode].floor : null });
});

// 스테이션이 꺼지거나 멀어졌을 때도 화면이 갱신되도록 주기적으로 전송
setInterval(broadcast, 1000);

// ===== 서버 자동 찾기 =====
// 2초마다 같은 와이파이 안에 "DGU-NAV 3001"을 방송 → ESP32가 이걸 듣고 노트북 IP를 알아냄
// 그래서 핫스팟을 바꾸거나 IP가 바뀌어도 ESP32를 다시 업로드할 필요가 없음
const dgram = require('dgram');
const os = require('os');
const DISCOVERY_PORT = 4210;
function lanAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a);
  return out;
}
const udp = dgram.createSocket('udp4');
udp.on('error', e => console.log('[자동찾기] UDP 오류:', e.message));
udp.bind(() => {
  udp.setBroadcast(true);
  const msg = Buffer.from(`DGU-NAV ${PORT}`);
  setInterval(() => {
    for (const a of lanAddrs()) {
      const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number);
      const bc = ip.map((o, i) => (o & m[i]) | (~m[i] & 255)).join('.');
      udp.send(msg, DISCOVERY_PORT, bc, () => {});
    }
  }, 2000);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`서버 실행: http://localhost:${PORT}`);
  for (const a of lanAddrs()) console.log(`  폰/다른 기기에서: http://${a.address}:${PORT}`);
  console.log(`층 지도 스테이션: ${Object.keys(map.stations).length}개, 층: ${map.floors.map(f => f.id + 'F').join(', ')} · 네모방은 S1~S${ROOM_STATIONS}만 사용`);
});
