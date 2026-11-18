// 화면 선택 막대: 모든 페이지 맨 위에 붙음 (<script src="/nav.js"></script>)
//  네모방(방 위치 측정) · 신공학관 지도 · 로봇 실험 결과
(function () {
  const PAGES = [
    { href: '/room.html',    match: ['/', '/room.html'], label: '네모방', sub: '방 위치 측정' },
    { href: '/index.html',   match: ['/index.html'],     label: '신공학관 지도', sub: '6층 길찾기' },
    { href: '/results.html', match: ['/results.html'],   label: '실험 결과', sub: '로봇 주행 기록' },
  ];
  const here = location.pathname;
  const css = `
    .dgu-nav { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:8px 16px;
               background:#101218; border-bottom:1px solid #2b2f3a; font-family:system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
    .dgu-nav .brand { color:#8a92a3; font-size:13px; margin-right:8px; white-space:nowrap; }
    .dgu-nav a { display:flex; align-items:baseline; gap:6px; padding:6px 12px; border-radius:8px; text-decoration:none;
                 color:#c9cfdb; background:#1f222b; border:1px solid #2b2f3a; font-size:14px; font-weight:600; }
    .dgu-nav a small { color:#8a92a3; font-weight:400; font-size:12px; }
    .dgu-nav a:hover { border-color:#4a5060; }
    .dgu-nav a.on { background:#ff4d5a; border-color:#ff4d5a; color:#fff; }
    .dgu-nav a.on small { color:#ffe3e5; }
    @media (max-width: 560px) { .dgu-nav a small { display:none; } .dgu-nav .brand { display:none; } }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const nav = document.createElement('nav');
  nav.className = 'dgu-nav';
  nav.innerHTML = '<span class="brand">DGU 실내 내비게이션</span>' + PAGES.map(p =>
    `<a href="${p.href}" class="${p.match.includes(here) ? 'on' : ''}">${p.label} <small>${p.sub}</small></a>`).join('');
  document.body.prepend(nav);
  // 페이지 body에 여백(padding)이 있으면 막대를 화면 끝까지 늘림
  const cs = getComputedStyle(document.body);
  const pt = parseFloat(cs.paddingTop) || 0, pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
  if (pt || pl || pr) nav.style.margin = `${-pt}px ${-pr}px ${pt}px ${-pl}px`;
})();
