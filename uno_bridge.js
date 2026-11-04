// 우노 설정기 ↔ 서버 중계 프로그램
// 사용법:  node uno_bridge.js          → 연결된 포트 목록 보여주고 아두이노로 보이는 포트 자동 선택
//          node uno_bridge.js COM5     → 포트 직접 지정
// 먼저 다른 창에서 node server.js 가 켜져 있어야 하고, Arduino IDE 시리얼 모니터는 닫아야 해요.
let SerialPort, ReadlineParser;
try { ({ SerialPort, ReadlineParser } = require('serialport')); }
catch (e) {
  console.log('serialport 모듈이 없어요. 이 폴더에서  npm install serialport  을 한 번 실행하세요.');
  process.exit(1);
}

const SERVER = process.env.SERVER || 'http://localhost:3001';   // 클라우드면 set SERVER=https://...
const KEY = process.env.DEVICE_KEY || '';
const BAUD = 9600;

async function pickPort() {
  const want = process.argv[2];
  const ports = await SerialPort.list();
  console.log('연결된 포트:');
  for (const p of ports) console.log(`  ${p.path}  ${p.manufacturer ?? ''} ${p.friendlyName ?? ''}`);
  if (want) return want;
  const guess = ports.find(p => /arduino|wch|ch340|ftdi|usb.?serial/i.test(`${p.manufacturer} ${p.friendlyName}`));
  if (!guess) { console.log('\n아두이노 포트를 못 찾았어요.  node uno_bridge.js COM5  처럼 직접 지정하세요.'); process.exit(1); }
  return guess.path;
}

function toUno(port, state) {
  const p = state.positions || {};
  const pos = ['STATION_01', 'STATION_02', 'STATION_03', 'STATION_04'].map(id => p[id] ?? 0);
  port.write(`POS ${pos.join(' ')}\n`);
  const near = state.nearest && /^STATION_0[1-4]$/.test(state.nearest) ? +state.nearest.slice(-1) : 0;
  port.write(state.estimate == null ? `EST - ${near}\n` : `EST ${state.estimate.toFixed(1)} ${near}\n`);
}

async function main() {
  const path = await pickPort();
  const port = new SerialPort({ path, baudRate: BAUD });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  port.on('open', () => console.log(`\n${path} 연결됨. 우노 버튼을 눌러보세요. (끄려면 Ctrl+C)`));
  port.on('error', e => { console.log('포트 오류:', e.message, '\n→ Arduino IDE 시리얼 모니터가 열려 있으면 닫으세요.'); process.exit(1); });

  parser.on('data', async raw => {
    const line = raw.trim();
    try {
      if (line === 'GET') {
        toUno(port, await (await fetch(`${SERVER}/corridor`)).json());
      } else if (line.startsWith('SET ')) {
        const v = line.slice(4).split(/\s+/).map(Number);
        const positions = { STATION_01: v[0], STATION_02: v[1], STATION_03: v[2], STATION_04: v[3] };
        const res = await fetch(`${SERVER}/corridor`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Key': KEY }, body: JSON.stringify({ positions }),
        });
        console.log(`[설정] 1:${v[0]}m 2:${v[1]}m 3:${v[2]}m 4:${v[3]}m → 서버 ${res.status}`);
        if (res.ok) toUno(port, await res.json());
      }
    } catch (e) {
      console.log('서버에 연결할 수 없어요. 다른 창에서 node server.js 가 켜져 있는지 확인하세요.');
    }
  });

  // 1초마다 폰 추정 위치를 우노로 보내기
  setInterval(async () => {
    try { toUno(port, await (await fetch(`${SERVER}/corridor`)).json()); } catch (e) {}
  }, 1000);
}

main();
