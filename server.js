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

const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'map.json'), 'utf8'));
const nodeById = Object.fromEntries(map.nodes.map(n => [n.id, n]));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const history = {};   // station -> 최근 RSSI
const lastSeen = {};
let current = null;   // 현재 판단된 스테이션 ID

function snapshot() {
  const now = Date.now();
  const status = {};
  for (const id of Object.keys(map.stations)) {
    const fresh = lastSeen[id] && now - lastSeen[id] < STALE_MS;
    status[id] = fresh ? Math.round(history[id].reduce((a, b) => a + b, 0) / history[id].length) : null;
  }
  return status;
}

function decide(status) {
  const alive = Object.entries(status).filter(([, r]) => r !== null && r > MIN_RSSI);
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
let roomSmooth = null;

function estimateRoom(status) {
  const parts = [];
  for (const [id, s] of Object.entries(room.stations)) {
    if (status[id] == null) continue;
    const d = rssiToMeters(status[id]);
    parts.push({ id, rssi: status[id], d: +d.toFixed(2), x: s.x, y: s.y });
  }
  if (!parts.length) { roomSmooth = null; return { estimate: null, parts }; }
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
  // 화면에서 덜 튀도록 이전 값과 섞기
  roomSmooth = roomSmooth ? { x: roomSmooth.x * 0.5 + best.x * 0.5, y: roomSmooth.y * 0.5 + best.y * 0.5 } : best;
  return { estimate: { x: +roomSmooth.x.toFixed(2), y: +roomSmooth.y.toFixed(2) }, parts };
}

let lastRoom = { estimate: null, parts: [] };
app.get('/health', (req, res) => res.json({ ok: true, keyRequired: !!DEVICE_KEY, stations: Object.fromEntries(Object.keys(lastSeen).map(id => [id, Math.round((Date.now() - lastSeen[id]) / 1000) + 's 전'])) }));
app.get('/room', (req, res) => res.json({ ...room, ...lastRoom }));
app.post('/room', canWrite, (req, res) => {
  const b = req.body || {};
  const w = +b.width, h = +b.height;
  if (!(w >= 0.5 && w <= 50 && h >= 0.5 && h <= 50) || !b.stations) return res.sendStatus(400);
  const stations = {};
  for (const id of ['STATION_01', 'STATION_02', 'STATION_03', 'STATION_04']) {
    const s = b.stations[id];
    if (!s || !Number.isFinite(+s.x) || !Number.isFinite(+s.y)) return res.sendStatus(400);
    stations[id] = { x: r1(Math.min(Math.max(+s.x, 0), w)), y: r1(Math.min(Math.max(+s.y, 0), h)) };
  }
  room = { width: r1(w), height: r1(h), stations };
  try { fs.writeFileSync(ROOM_FILE, JSON.stringify(room, null, 1)); } catch (e) {}
  console.log(`[방] ${room.width}m x ${room.height}m  ` +
    Object.entries(stations).map(([id, s]) => `S${id.slice(-1)}(${s.x}, ${s.y})`).join(' '));
  roomSmooth = null;
  broadcast();
  res.json({ ...room, ...lastRoom });
});

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
  if (!map.stations[station] || typeof rssi !== 'number') return res.sendStatus(400);
  history[station] = (history[station] || []).concat(rssi).slice(-WINDOW);
  lastSeen[station] = Date.now();
  console.log(`[수신] ${station} (${map.stations[station]}): ${rssi}dBm (약 ${rssiToMeters(rssi).toFixed(1)}m)`);
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
  console.log(`등록된 스테이션: ${Object.keys(map.stations).length}개, 층: ${map.floors.map(f => f.id + 'F').join(', ')}`);
});
