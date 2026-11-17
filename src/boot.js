// Boot sequence, about five seconds, silent.
// 0.0s  a soft light blooms; five members of the team fly in on spiralling paths with light trails
// 1.4s  four land on the corners of the AgentDesk diamond, the lead (Claude) lands in the middle
// 1.5s  the diamond is drawn through them; 1.95s the dark glass tile condenses behind it with a shock ring
// 2.2s  the lead becomes the ">" prompt and the cursor starts blinking; a light sweep crosses the tile
// 2.6s  the wordmark rises letter by letter; 3.3s a greeting with the real connection state
// 5.0s  everything dissolves into the app (or offers retry / offline when the cloud is unreachable)
// The SVG mark and text are animated by boot.css; this file draws the light, the members and their trails.
(function () {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const boot = $('boot');
  const canvas = $('bootCanvas');
  const ctx = canvas.getContext('2d');
  const mark = $('bootMark');
  const actions = $('bootActions');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const feed = window.AgentDeskBootFeed;
  const DURATION = 5;
  const TAU = Math.PI * 2;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t = clamp(t), t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const easeOut = (t) => 1 - (1 - clamp(t)) ** 3;
  const window01 = (t, a, b) => clamp((t - a) / (b - a));

  // Corner offsets of the diamond in the 256-unit icon, measured to the visual apex of its rounded corners.
  const APEX = 74 / 256;
  const members = [
    { id: 'grok', color: '#3d4452', corner: [0, -1], start: 0.10, land: 1.32, spin: 0.62 },
    { id: 'gemini', color: '#4f7cf0', corner: [1, 0], start: 0.16, land: 1.40, spin: -0.58 },
    { id: 'codex', color: '#10a37f', corner: [0, 1], start: 0.22, land: 1.48, spin: 0.66 },
    { id: 'antigravity', color: '#8b5cf6', corner: [-1, 0], start: 0.28, land: 1.56, spin: -0.7 },
    { id: 'lead', color: '#d97757', corner: [0, 0], start: 0.30, land: 1.66, spin: 0.8 },
  ];
  members.forEach((m, i) => { m.from = -Math.PI / 2 + i * TAU / 5 + 0.35; });

  let run;
  let exitTimer;

  function size() {
    const width = innerWidth;
    const height = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const box = mark.getBoundingClientRect();
    return { width, height, cx: box.left + box.width / 2, cy: box.top + box.height / 2, s: box.width };
  }

  // Where a member is at time t: a spiral that tightens onto its landing point.
  function position(m, t, view) {
    const progress = window01(t, m.start, m.land);
    const p = easeInOut(progress);
    const [dx, dy] = m.corner;
    const targetR = Math.hypot(dx, dy) * APEX * view.s;
    const targetA = Math.atan2(dy, dx);
    const startR = Math.hypot(view.width, view.height) * 0.46;
    const r = lerp(startR, targetR, easeOut(p * 1.05));
    const a = m.corner[0] || m.corner[1] ? targetA - (1 - p) * m.spin * TAU : m.from + p * m.spin * TAU;
    const squash = lerp(0.72, 1, p);
    return { x: view.cx + r * Math.cos(a), y: view.cy + r * Math.sin(a) * squash, progress };
  }

  function aurora(t, view) {
    const bloom = easeOut(t / 0.9);
    const R = Math.max(view.width, view.height) * 0.5;
    const blobs = [
      ['95,224,198', 0.26, -0.22, -0.10, 0.9],
      ['108,140,240', 0.24, 0.24, 0.06, 1.0],
      ['217,119,87', 0.08, 0.02, 0.30, 0.8],
    ];
    for (const [rgb, alpha, ox, oy, scale] of blobs) {
      const x = view.cx + (ox + 0.04 * Math.sin(t * 0.6 + ox * 9)) * view.width;
      const y = view.cy + (oy + 0.03 * Math.cos(t * 0.5 + oy * 7)) * view.height;
      const g = ctx.createRadialGradient(x, y, 0, x, y, R * scale);
      g.addColorStop(0, `rgba(${rgb},${alpha * bloom})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, view.width, view.height);
    }
  }

  function glow(x, y, color, alpha, radius) {
    ctx.globalAlpha = alpha * 0.35;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, color);
    g.addColorStop(1, color + '00');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4.6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 1.8, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function ring(x, y, radius, width, color, alpha) {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function draw(t) {
    const view = size();
    ctx.clearRect(0, 0, view.width, view.height);
    aurora(t, view);
    const halo = window01(t, 2.0, 2.8);
    if (halo > 0) {
      const breathe = 0.85 + 0.15 * Math.sin((t - 2.0) * 2.4);
      const g = ctx.createRadialGradient(view.cx, view.cy + view.s * 0.08, view.s * 0.2, view.cx, view.cy + view.s * 0.08, view.s * 1.25);
      g.addColorStop(0, `rgba(95,200,210,${0.30 * halo * breathe})`);
      g.addColorStop(0.55, `rgba(108,140,240,${0.12 * halo * breathe})`);
      g.addColorStop(1, 'rgba(108,140,240,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, view.width, view.height);
    }

    // The members and their trails, until they have become the mark.
    for (const m of members) {
      const fade = m.id === 'lead' ? 1 - window01(t, 2.2, 2.6) : 1 - window01(t, 1.6, 2.15);
      if (t < m.start || fade <= 0) continue;
      const head = position(m, t, view);
      ctx.lineCap = 'round';
      let previous = head;
      for (let i = 1; i <= 34; i++) {
        const back = t - i * 0.016;
        if (back < m.start) break;
        const point = position(m, back, view);
        const k = 1 - i / 34;
        ctx.globalAlpha = 0.6 * k * fade * (1 - head.progress ** 6);
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 0.6 + 4.6 * k * k;
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        previous = point;
      }
      ctx.globalAlpha = 1;
      glow(head.x, head.y, m.color, fade, lerp(30, 18, head.progress));
      const landed = t - m.land;
      if (landed > 0 && landed < 0.7) ring(head.x, head.y, 4 + 30 * easeOut(landed / 0.7), 1.4, m.color, 0.5 * (1 - landed / 0.7));
    }

    // The tile condenses: a flash and one shock ring across the light.
    const flash = window01(t, 1.9, 2.05) * (1 - window01(t, 2.05, 2.6));
    if (flash > 0) {
      const g = ctx.createRadialGradient(view.cx, view.cy, 0, view.cx, view.cy, view.s * 1.4);
      g.addColorStop(0, `rgba(255,255,255,${0.9 * flash})`);
      g.addColorStop(0.4, `rgba(140,200,230,${0.25 * flash})`);
      g.addColorStop(1, 'rgba(140,200,230,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, view.width, view.height);
    }
    const shock = window01(t, 1.98, 3.1);
    if (shock > 0 && shock < 1) {
      const radius = lerp(view.s * 0.55, Math.hypot(view.width, view.height) * 0.6, easeOut(shock));
      ring(view.cx, view.cy, radius, lerp(2.2, 0.6, shock), '#5fa8d8', 0.38 * (1 - shock));
      ring(view.cx, view.cy, radius * 0.86, 1, '#5fe0c6', 0.22 * (1 - shock));
    }

    // Afterwards the team keeps circling the mark, small and quiet.
    const after = window01(t, 2.9, 3.6);
    if (after > 0) {
      members.forEach((m, i) => {
        const a = -Math.PI / 2 + i * TAU / 5 + t * 0.35;
        const r = view.s * 1.05;
        const x = view.cx + r * Math.cos(a);
        const y = view.cy + r * Math.sin(a) * 0.38 + view.s * 0.02;
        const front = (Math.sin(a) + 1) / 2;
        glow(x, y, m.color, after * (0.3 + 0.6 * front), 9 + 5 * front);
      });
      ctx.globalAlpha = 1;
    }
  }

  function greeting() {
    const hour = new Date().getHours();
    return hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : hour < 23 ? '晚上好' : '夜深了';
  }

  function status(data) {
    const element = $('bootGreet');
    const agents = data.nodes.filter((node) => node.id !== 'local');
    const checked = agents.every((node) => Number.isFinite(node.at));
    let text;
    let warn = false;
    if (data.offline) { text = greeting() + '，云端暂未连接'; warn = true; }
    else if (!checked) text = greeting() + '，正在召集团队…';
    else {
      const ready = agents.filter((node) => node.kind === 'ok').length;
      text = greeting() + '，' + ready + ' 位成员已就位';
      warn = ready === 0;
    }
    const key = text + warn;
    if (element.dataset.key === key) return;
    element.dataset.key = key;
    const dot = document.createElement('span');
    dot.className = 'dot' + (warn ? ' warn' : '');
    element.replaceChildren(dot, document.createTextNode(text));
  }

  function finish(fade = false) {
    if (!run) return;
    cancelAnimationFrame(run.frame);
    clearTimeout(run.timer);
    run.cancelChecks();
    run = null;
    const hide = () => {
      root.dataset.bootplay = 'no';
      delete root.dataset.boot;
      boot.classList.remove('leaving', 'run', 'still');
      $('input')?.focus({ preventScroll: true });
    };
    if (fade && !motion.matches) {
      boot.classList.add('leaving');
      exitTimer = setTimeout(hide, 760);
    } else hide();
  }

  function start() {
    finish();
    clearTimeout(exitTimer);
    boot.classList.remove('leaving', 'run', 'still');
    actions.hidden = true;
    root.dataset.bootplay = 'yes';
    root.dataset.boot = 'playing';
    $('bootBuild').textContent = 'V' + (window.desk.system.version || '');
    const word = $('bootWord');
    word.replaceChildren(...[...'AgentDesk'].map((letter, i) => {
      const span = document.createElement('span');
      span.textContent = letter;
      span.style.setProperty('--i', i);
      if (i >= 5) span.className = 'accent';
      return span;
    }));
    $('bootGreet').dataset.key = '';
    void boot.offsetWidth;   // restart the CSS timeline on a replay
    const quick = motion.matches;
    boot.classList.add(quick ? 'still' : 'run');
    $('bootSkip').focus({ preventScroll: true });
    const active = { data: feed.buildBootData(), start: performance.now() };
    run = active;
    status(active.data);
    active.cancelChecks = feed.collect(window.desk, (data) => {
      active.data = data;
      status(data);
    });
    const end = () => {
      cancelAnimationFrame(active.frame);
      if (active.data.offline) {
        actions.hidden = false;
        $('bootRetry').focus({ preventScroll: true });
      } else finish(true);
    };
    if (quick) draw(DURATION);
    else {
      const frame = (now) => {
        draw((now - active.start) / 1000);
        active.frame = requestAnimationFrame(frame);
      };
      active.frame = requestAnimationFrame(frame);
    }
    active.timer = setTimeout(end, quick ? 1000 : DURATION * 1000);
  }

  window.__boot = {
    skip: () => finish(),
    replay: start,
    setEnabled(enabled) { if (!enabled) finish(); },
    isPlaying: () => root.dataset.boot === 'playing',
    // Stops the sequence at t seconds, for screenshots and design review.
    freeze(t) {
      if (!run) return;
      cancelAnimationFrame(run.frame);
      clearTimeout(run.timer);
      for (const animation of boot.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = t * 1000;
      }
      draw(t);
    },
  };
  $('bootSkip').addEventListener('click', () => finish());
  $('bootOffline').addEventListener('click', () => finish());
  $('bootRetry').addEventListener('click', start);
  boot.addEventListener('dblclick', () => finish());
  document.addEventListener('keydown', (event) => {
    if (!run || !['Escape', 'Enter', ' '].includes(event.key)) return;
    if (!actions.hidden && event.key !== 'Escape' && event.target.closest('#bootActions button')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish();
  }, true);
  if (root.dataset.bootplay === 'yes') start();
})();
