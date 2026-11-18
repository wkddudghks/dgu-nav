// 스테이션 위치 자동 추정 (자기 위치 추정, self-localization)
//  1) 스테이션끼리 서로의 BLE 신호 세기(RSSI)를 잰다 → 쌍마다 중앙값 → 거리(m)로 변환
//  2) "지도 위 거리 = 잰 거리"가 되도록 점들을 옮기는 응력 최소화(stress majorization)로 2D 배치
//     가까운 쌍일수록 RSSI가 믿을 만하므로 가중치 1/d² 를 줌
//  3) 회전·뒤집힘은 신호만으로는 알 수 없음 → 이전 배치(있으면)에 맞춰 돌리고, 없으면 S1→S2를 가로축으로
// 순수 함수만 있음 (server.js와 시험 스크립트가 같이 씀)

function rssiToDist(rssi, tx, n) { return Math.pow(10, (tx - rssi) / (10 * n)); }

function median(a) {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 난수(재현 가능) — 시작점 여러 개를 시험할 때 사용
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function stressOf(X, pairs) {
  let s = 0;
  for (const p of pairs) {
    const d = Math.hypot(X[p.i][0] - X[p.j][0], X[p.i][1] - X[p.j][1]);
    s += p.w * (d - p.d) ** 2;
  }
  return s;
}

// 응력 최소화 (점 하나씩 옮기는 방식) — n이 20개 이하라 충분히 빠름
function majorize(X, nbr, iters) {
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < X.length; i++) {
      let sw = 0, sx = 0, sy = 0;
      for (const { j, d, w } of nbr[i]) {
        const dx = X[i][0] - X[j][0], dy = X[i][1] - X[j][1];
        const cur = Math.hypot(dx, dy) || 1e-6;
        sx += w * (X[j][0] + d * dx / cur);
        sy += w * (X[j][1] + d * dy / cur);
        sw += w;
      }
      if (sw > 0) X[i] = [sx / sw, sy / sw];
    }
  }
  return X;
}

// 고전 MDS (빠진 쌍은 최단 경로로 채워서) — 좋은 시작점
function classicalMDS(D) {
  const n = D.length;
  const J = (i, j) => (i === j ? 1 : 0) - 1 / n;
  const D2 = D.map(r => r.map(v => v * v));
  const B = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    let s = 0;
    for (let k = 0; k < n; k++) for (let l = 0; l < n; l++) s += J(i, k) * D2[k][l] * J(l, j);
    return -s / 2;
  }));
  const vecs = [];
  let M = B.map(r => [...r]);
  for (let e = 0; e < 2; e++) {               // 거듭제곱법으로 큰 고유벡터 2개
    let v = Array.from({ length: n }, (_, i) => Math.sin(i + 1 + e));
    let lam = 0;
    for (let it = 0; it < 300; it++) {
      const u = M.map(r => r.reduce((s, x, k) => s + x * v[k], 0));
      lam = Math.hypot(...u);
      if (lam < 1e-9) break;
      v = u.map(x => x / lam);
    }
    vecs.push(v.map(x => x * Math.sqrt(Math.max(lam, 0))));
    M = M.map((r, i) => r.map((x, j) => x - lam * v[i] * v[j]));
  }
  return Array.from({ length: n }, (_, i) => [vecs[0][i], vecs[1][i]]);
}

// 회전·뒤집힘·평행이동으로 A를 B에 맞춤 (크기는 그대로) — 화면에서 배치가 돌아가지 않게
function procrustes(A, B) {
  const n = A.length, ca = [0, 0], cb = [0, 0];
  for (let i = 0; i < n; i++) { ca[0] += A[i][0] / n; ca[1] += A[i][1] / n; cb[0] += B[i][0] / n; cb[1] += B[i][1] / n; }
  let best = null;
  for (const flip of [1, -1]) {
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const ax = A[i][0] - ca[0], ay = (A[i][1] - ca[1]) * flip, bx = B[i][0] - cb[0], by = B[i][1] - cb[1];
      sxx += ax * bx + ay * by; sxy += ax * by - ay * bx;
    }
    const th = Math.atan2(sxy, sxx), c = Math.cos(th), s = Math.sin(th);
    const map = p => { const x = p[0] - ca[0], y = (p[1] - ca[1]) * flip; return [c * x - s * y + cb[0], s * x + c * y + cb[1]]; };
    let err = 0;
    for (let i = 0; i < n; i++) { const q = map(A[i]); err += (q[0] - B[i][0]) ** 2 + (q[1] - B[i][1]) ** 2; }
    if (!best || err < best.err) best = { err, map };
  }
  return best.map;
}

/**
 * links: [{a, b, rssi}]  (a, b = 스테이션 ID, rssi = 그 쌍의 대표 RSSI)
 * opt: { tx, n, prev: {id: {x,y}}, margin, seed }
 * 반환: { positions: {id: {x,y}}, width, height, rms, perStation: {id: {links, rms}}, warnings: [] }
 */
function solveLayout(ids, links, opt = {}) {
  const tx = opt.tx ?? -59, n = opt.n ?? 2.5, margin = opt.margin ?? 0.5;
  const idx = Object.fromEntries(ids.map((id, i) => [id, i]));
  const N = ids.length;
  const pairs = [];
  for (const l of links) {
    if (!(l.a in idx) || !(l.b in idx) || l.a === l.b) continue;
    const d = Math.min(Math.max(rssiToDist(l.rssi, tx, n), 0.3), 40);
    pairs.push({ i: idx[l.a], j: idx[l.b], d, w: 1 / (d * d) });
  }
  const nbr = Array.from({ length: N }, () => []);
  for (const p of pairs) { nbr[p.i].push({ j: p.j, d: p.d, w: p.w }); nbr[p.j].push({ j: p.i, d: p.d, w: p.w }); }
  const warnings = [];
  ids.forEach((id, i) => { if (nbr[i].length < 3) warnings.push(`${label(id)}: 이웃 신호 ${nbr[i].length}개 (3개 이상 필요)`); });

  // 연결돼 있는지 확인 (끊긴 무리는 서로 위치를 알 수 없음)
  const seen = new Set([0]), stack = [0];
  while (stack.length) { const i = stack.pop(); for (const { j } of nbr[i]) if (!seen.has(j)) { seen.add(j); stack.push(j); } }
  if (seen.size < N) warnings.push(`서로 신호가 닿지 않는 스테이션이 있음: ${ids.filter((_, i) => !seen.has(i)).map(label).join(', ')}`);

  // 빠진 쌍은 최단 경로 거리로 채워 고전 MDS 시작점을 만듦
  const D = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 0 : Infinity)));
  for (const p of pairs) D[p.i][p.j] = D[p.j][p.i] = Math.min(D[p.i][p.j], p.d);
  for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
    if (D[i][k] + D[k][j] < D[i][j]) D[i][j] = D[i][k] + D[k][j];
  const finite = D.flat().filter(Number.isFinite), big = Math.max(...finite, 1) * 1.5;
  const Df = D.map(r => r.map(v => (Number.isFinite(v) ? v : big)));

  const rand = rng(opt.seed ?? 7);
  let best = null;
  const starts = [classicalMDS(Df)];
  for (let s = 0; s < 24; s++) starts.push(Array.from({ length: N }, () => [rand() * big, rand() * big]));
  for (const X0 of starts) {
    const X = majorize(X0.map(p => [...p]), nbr, 400);
    const st = stressOf(X, pairs);
    if (!best || st < best.st) best = { X, st };
  }
  let X = best.X;
  // 기준 거리: 두 스테이션 사이를 줄자로 잰 값에 맞춰 전체 크기를 늘리거나 줄임
  //  (한 쌍의 RSSI로 보정하면 그 쌍의 치우침이 전체를 망치므로, 전체 배치를 다 구한 뒤 크기만 맞춤)
  let scale = 1;
  if (opt.ref && opt.ref.a in idx && opt.ref.b in idx && opt.ref.d > 0) {
    const A = X[idx[opt.ref.a]], B = X[idx[opt.ref.b]], cur = Math.hypot(A[0] - B[0], A[1] - B[1]);
    if (cur > 0.05) { scale = opt.ref.d / cur; X = X.map(([x, y]) => [x * scale, y * scale]); }
  }

  // 방향 맞추기: 이전 배치가 3개 이상 있으면 거기에 맞춰 회전/뒤집기, 아니면 첫 두 스테이션을 가로축으로
  const prevIds = ids.filter(id => opt.prev && opt.prev[id]);
  if (prevIds.length >= 3) {
    const f = procrustes(prevIds.map(id => X[idx[id]]), prevIds.map(id => [opt.prev[id].x, opt.prev[id].y]));
    X = X.map(f);
  } else if (N >= 2) {
    const [x0, y0] = X[0], th = Math.atan2(X[1][1] - y0, X[1][0] - x0), c = Math.cos(-th), s = Math.sin(-th);
    X = X.map(([x, y]) => [c * (x - x0) - s * (y - y0), s * (x - x0) + c * (y - y0)]);
    if (N >= 3 && X[2][1] < 0) X = X.map(([x, y]) => [x, -y]);
  }
  // 방 안으로 옮기기 (가장 왼쪽·위 스테이션이 margin m 떨어지게)
  const minX = Math.min(...X.map(p => p[0])), minY = Math.min(...X.map(p => p[1]));
  X = X.map(([x, y]) => [x - minX + margin, y - minY + margin]);
  const r1 = v => Math.round(v * 10) / 10;
  const width = Math.ceil((Math.max(...X.map(p => p[0])) + margin) * 10) / 10;
  const height = Math.ceil((Math.max(...X.map(p => p[1])) + margin) * 10) / 10;

  // 잔차: 배치한 거리와 잰 거리 차이
  const perStation = Object.fromEntries(ids.map(id => [id, { links: 0, se: 0 }]));
  let se = 0;
  for (const p of pairs) {
    const e = Math.hypot(X[p.i][0] - X[p.j][0], X[p.i][1] - X[p.j][1]) - p.d * scale;
    se += e * e;
    for (const k of [p.i, p.j]) { perStation[ids[k]].links++; perStation[ids[k]].se += e * e; }
  }
  for (const id of ids) { const s = perStation[id]; s.rms = s.links ? +Math.sqrt(s.se / s.links).toFixed(2) : null; delete s.se; }
  return {
    positions: Object.fromEntries(ids.map((id, i) => [id, { x: r1(X[i][0]), y: r1(X[i][1]) }])),
    width: Math.max(width, 0.5), height: Math.max(height, 0.5),
    rms: pairs.length ? +Math.sqrt(se / pairs.length).toFixed(2) : null,
    perStation, warnings, pairs: pairs.length, scale: +scale.toFixed(3),
  };
}

function label(id) { return 'S' + parseInt(String(id).slice(-2), 10); }

module.exports = { solveLayout, rssiToDist, median, procrustes, label };
