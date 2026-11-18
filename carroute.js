// 길잡이 로봇 경로: 지도(map.json)의 최단 경로 → 우노가 알아듣는 주행 명령
//  우노 명령 (car_uno.ino)
//   <  /  >   : 그 자리에서 왼쪽 / 오른쪽 90° 회전
//   U         : 그 자리에서 180° 회전
//   L<cm> / R<cm> : 벽을 따라 <cm>쯤 간 뒤 나오는 갈림길에서 왼쪽 / 오른쪽으로 회전
//                   (85% 전에 나오는 문틈은 무시, 115%까지 갈림길이 안 보이면 그 자리에서 회전)
//   F<cm>     : 벽을 따라 <cm> 가고 멈춤 (도착)
//  방향: N = 지도 위쪽, E = 오른쪽, S = 아래쪽, W = 왼쪽 (지도 좌표는 y가 아래로 커짐)
const DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

function nearestDir(dx, dy) {
  let best = 'N', bd = -2;
  const L = Math.hypot(dx, dy) || 1;
  for (const [k, [x, y]] of Object.entries(DIRS)) { const d = (dx * x + dy * y) / L; if (d > bd) { bd = d; best = k; } }
  return best;
}
// 방향 a에서 b로 바꾸려면: 0 = 그대로, 1 = 오른쪽, -1 = 왼쪽, 2 = 뒤로
function turnOf(a, b) {
  const order = ['N', 'E', 'S', 'W'];
  const d = (order.indexOf(b) - order.indexOf(a) + 4) % 4;
  return d === 0 ? 0 : d === 1 ? 1 : d === 3 ? -1 : 2;
}

function buildGraph(map, floor) {
  const node = Object.fromEntries(map.nodes.filter(n => n.floor === floor).map(n => [n.id, n]));
  const adj = {};
  for (const [a, b, w] of map.edges) {
    if (!node[a] || !node[b]) continue;                       // 다른 층으로 가는 연결은 뺌 (로봇은 한 층만)
    const c = w ?? Math.hypot(node[a].x - node[b].x, node[a].y - node[b].y) / map.pxPerM;
    (adj[a] ||= []).push([b, c]); (adj[b] ||= []).push([a, c]);
  }
  return { node, adj };
}

function shortest(g, from, to) {
  const dist = { [from]: 0 }, prev = {}, done = new Set();
  while (true) {
    let u = null;
    for (const k in dist) if (!done.has(k) && (u === null || dist[k] < dist[u])) u = k;
    if (u === null) return null;
    if (u === to) break;
    done.add(u);
    for (const [v, c] of g.adj[u] || []) if (!(v in dist) || dist[u] + c < dist[v]) { dist[v] = dist[u] + c; prev[v] = u; }
  }
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return { path, meters: dist[to] };
}

/**
 * from, to: 노드 ID (예 "6F_D_103"), heading: 차가 지금 보는 방향 'N'|'E'|'S'|'W'
 * 반환: { route: "R1250,L640,F320", steps: [사람이 읽는 설명], meters, endHeading, path }
 */
function planRoute(map, from, to, heading, floor = 6) {
  const g = buildGraph(map, floor);
  if (!g.node[from] || !g.node[to]) return { error: '출발 또는 목적지 지점이 지도에 없어요' };
  if (!DIRS[heading]) return { error: '방향은 N, E, S, W 중 하나' };
  if (from === to) return { route: '', steps: ['이미 목적지 앞이에요'], meters: 0, endHeading: heading, path: [from] };
  const sp = shortest(g, from, to);
  if (!sp) return { error: '경로를 찾을 수 없어요' };

  // 같은 방향으로 이어지는 간선을 한 구간으로 합침 (출입구 지점은 그냥 지나감)
  const legs = [];
  for (let i = 1; i < sp.path.length; i++) {
    const A = g.node[sp.path[i - 1]], B = g.node[sp.path[i]];
    const dir = nearestDir(B.x - A.x, B.y - A.y), m = Math.hypot(B.x - A.x, B.y - A.y) / map.pxPerM;
    const last = legs[legs.length - 1];
    if (m < 0.1) { if (last) last.to = B.id; continue; }     // 같은 자리에 겹친 지점(출입구 = 갈림길)은 건너뜀
    if (last && last.dir === dir) { last.m += m; last.to = B.id; } else legs.push({ dir, m, from: A.id, to: B.id });
  }
  const KO = { 1: '오른쪽', '-1': '왼쪽', 2: '뒤로' };
  const out = [], steps = [];
  const t0 = turnOf(heading, legs[0].dir);
  if (t0 === 1) { out.push('>'); steps.push('제자리에서 오른쪽으로 돌기'); }
  if (t0 === -1) { out.push('<'); steps.push('제자리에서 왼쪽으로 돌기'); }
  if (t0 === 2) { out.push('U'); steps.push('제자리에서 뒤로 돌기'); }
  for (let i = 0; i < legs.length; i++) {
    const cm = Math.max(30, Math.round(legs[i].m * 100 / 10) * 10);
    if (i === legs.length - 1) { out.push(`F${cm}`); steps.push(`${(cm / 100).toFixed(1)}m 가서 도착`); break; }
    const t = turnOf(legs[i].dir, legs[i + 1].dir);
    if (t === 2) { out.push(`F${cm}`, 'U'); steps.push(`${(cm / 100).toFixed(1)}m 가서 뒤로 돌기`); continue; }
    out.push(`${t === 1 ? 'R' : 'L'}${cm}`);
    steps.push(`${(cm / 100).toFixed(1)}m 가서 갈림길에서 ${KO[t]}`);
  }
  return { route: out.join(','), steps, meters: +sp.meters.toFixed(1), endHeading: legs[legs.length - 1].dir, path: sp.path, legs: legs.length };
}

module.exports = { planRoute, nearestDir, turnOf };
