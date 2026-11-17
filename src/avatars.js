(() => {
'use strict';

// Canvas renderer adapted from docs/prototype/group-chat.html on the Claude branch.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const M = {
  you: { name: '你', short: '你', bot: false },
  lead: { name: '组长', short: '组', bot: true },
  codex: { name: 'Codex', short: 'CX', bot: true },
  claude: { name: 'Claude Code', short: 'CL', bot: true },
  gemini: { name: 'Gemini', short: 'GM', bot: true },
  grok: { name: 'Grok Build', short: 'GK', bot: true },
  antigravity: { name: 'Antigravity', short: 'AG', bot: true },
  local: { name: '本机', short: '本', bot: true },
};
const EYES = {
  lead:  { x: [6.744, 17.255], y: 9.53, w: 1.49, h: 2.85, holes: true },   // fills the mark's own eye holes
  claude:    { x: [10.3, 13.7], y: 12.2, w: 1.5, h: 2.6 },
  codex:    { x: [10.1, 13.9], y: 12.0, w: 1.6, h: 2.9, plate: 5.6 },   // line-art mark: eyes sit on a solid face plate
  antigravity:    { x: [10.0, 14.0], y: 14.2, w: 1.5, h: 2.6 },
  gemini:  { x: [10.2, 13.8], y: 12.0, w: 1.5, h: 2.6 },
  grok:    { x: [9.7, 14.3], y: 11.6, w: 1.5, h: 2.7 },
  local: { x: [6.75, 17.25], y: 6.75, w: 1.8, h: 3.0 },
};
// State vocabulary shared with task-runner and WeChat (/ls).
const STATES = {
  idle:     { label: '空闲',     group: 'rest', pill: '' },
  asleep:   { label: '休眠',     group: 'rest', pill: 'sleep' },
  limited:  { label: '额度用尽', group: 'rest', pill: 'limited' },
  peek:     { label: '鼠标悬停', group: 'react', pill: '' },
  thinking: { label: '思考中',   group: 'work', pill: 'work' },
  tool:     { label: '执行中',   group: 'work', pill: 'work' },
  long:     { label: '长任务',   group: 'work', pill: 'work' },
  compacting: { label: '整理上下文', group: 'work', pill: 'work' },
  juggling: { label: '协调中',   group: 'work', pill: 'work' },
  asking:   { label: '等你处理', group: 'ask',  pill: 'ask' },
  done:     { label: '完成',     group: 'end',  pill: 'done' },
  failed:   { label: '失败',     group: 'end',  pill: 'failed' },
};
const SHEET_ORDER = ['idle', 'asleep', 'limited', 'peek', 'thinking', 'tool', 'long', 'compacting', 'juggling', 'asking', 'done', 'failed'];

const avatars = new Map();
const lastStates = new Map();
const images = new Map();
const pointer = { x: 0, y: 0, at: -Infinity };
const isLight = () => document.documentElement.dataset.theme === 'light';
let colors;
let font;
let lastFrame = 0;
let frame;

function readColors() {
  const css = getComputedStyle(document.documentElement);
  font = getComputedStyle(document.body).fontFamily;
  colors = { ink: isLight() ? '#fff' : '#15171b', shadow: 'rgba(0,0,0,.26)' };
  for (const name of ['warn', 'danger', 'accent', 'muted']) colors[name] = css.getPropertyValue('--' + name).trim();
  for (const id of Object.keys(M)) colors[id] = css.getPropertyValue('--member-' + id).trim();
}

function logoImage(id) {
  if (!M[id].bot) return null;
  const name = id === 'local' && window.desk?.platform === 'darwin' ? 'mac' : id;
  const path = './avatar-assets/' + name + (['codex', 'grok'].includes(name) ? (isLight() ? '-light' : '-dark') : '') + '.svg';
  if (!images.has(path)) {
    const image = new Image();
    images.set(path, image);
    image.addEventListener('load', () => drawAll(true), { once: true });
    image.src = path;
  }
  return images.get(path);
}

function html(id, { state = 'idle', size = 34, still = false, preview = false, balls = [], key = '' } = {}) {
  if (!M[id]) return '';
  const label = M[id].name + ' · ' + STATES[state].label;
  return `<canvas class="member-avatar" data-member="${id}" data-avatar-state="${state}" data-size="${size}"
    data-avatar-key="${key.replace(/[&<>"]/g, '')}" data-balls="${balls.filter((member) => Object.hasOwn(M, member)).join(',')}"
    ${still ? 'data-still' : ''} ${preview ? 'data-preview' : ''} role="img" aria-label="${label}" width="${size}" height="${size}" style="width:${size}px;height:${size}px"></canvas>`;
}

function track(cv) {
  const now = performance.now();
  const key = cv.dataset.avatarKey;
  const previous = key && lastStates.get(key);
  const state = cv.dataset.avatarState;
  const since = previous?.state === state ? previous.since : now;
  const prev = previous?.state === state ? previous.prev : previous?.state;
  if (key) lastStates.set(key, { state, since, prev });
  const a = {
    cv, id: cv.dataset.member, size: +cv.dataset.size, state, prev, since,
    still: cv.hasAttribute('data-still'), fixed: cv.hasAttribute('data-preview'),
    balls: cv.dataset.balls.split(',').filter(Boolean),
    seed: Math.random() * 10, blinkAt: now + 1200 + Math.random() * 2800,
    morph: 0, hover: false, hoverOff: -Infinity, nextPeek: now + 12000 + Math.random() * 20000,
    peekUntil: 0, pokeUntil: 0, annoyedUntil: 0, pokes: [],
  };
  if (!a.still && M[a.id].bot) {
    cv.addEventListener('pointerenter', () => { a.hover = true; });
    cv.addEventListener('pointerleave', () => { a.hover = false; a.hoverOff = performance.now(); });
    cv.addEventListener('click', () => {
      const now = performance.now();
      a.pokes = a.pokes.filter((time) => now - time < 1500);
      a.pokes.push(now);
      if (a.pokes.length === 4) { a.annoyedUntil = now + 1800; a.pokes = []; }
      else a.pokeUntil = now + 520;
    });
  }
  avatars.set(cv, a);
  return a;
}
function drawBot(a, now) {
  const { cv, id, size } = a;
  const W = Math.round(size * Math.min(2, devicePixelRatio || 1));
  if (cv.width !== W) { cv.width = W; cv.height = W; }
  const ctx = cv.getContext('2d');
  let st = a.state;
  const still = a.still || reduceMotion.matches;
  const t = still ? 0 : now / 1000 + a.seed;
  const m = M[id];
  const s0 = a;
  const since = a.fixed ? (still ? 1100 : (now - a.since) % 4000) : now - a.since;   // the state sheet loops its one-shot moments
  if (!a.fixed && !still && (st === 'done' || st === 'failed') && since > 2400) st = 'idle';
  const rest = ['idle', 'asleep', 'limited'].includes(st);

  // Reactions and one-shot moments (inspired by Clawd on Desk's state design; drawn from scratch here)
  const poked = !still && now < a.pokeUntil;
  const annoyed = !still && now < a.annoyedUntil;
  if (!still && st === 'idle' && !a.fixed && now > a.nextPeek) { a.peekUntil = now + 2400; a.nextPeek = now + 18000 + Math.random() * 25000; }
  const idlePeek = !still && st === 'idle' && now < a.peekUntil;
  const hovering = !still && (a.hover || now - a.hoverOff < 900);
  const yawning = st === 'asleep' && since < 1800 && !still;
  const waking = !still && s0.prev === 'asleep' && !a.fixed && since < 900;
  const peek = st === 'peek' || ((hovering || idlePeek || poked || annoyed) && rest && st !== 'limited');

  // Not working: the plain logo. Working / needs you / result: the logo wakes up into a bot.
  const awake = m.bot && (!rest || peek || yawning || poked || annoyed);
  const target = !m.bot ? 0 : awake ? (rest || st === 'peek' ? 0.9 : 1) : 0;
  if (a.morph === null || still) a.morph = target; else a.morph += (target - a.morph) * 0.14;
  const k = a.morph;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, W);
  const L = W * 0.65;
  const cx = W * 0.44, cy = W * 0.57;
  let scale = 1, tilt = 0, lift = 0, shakeX = 0;
  if (!still) {
    if (st === 'idle') scale = 1 + Math.sin(t * 1.6) * 0.012;
    if (st === 'asleep') scale = 1 + Math.sin(t * 0.8) * 0.03;
    if (st === 'thinking') { tilt = Math.sin(t * 1.2) * 0.08; lift = Math.sin(t * 2.4) * 0.025; }
    if (st === 'tool') { lift = Math.abs(Math.sin(t * 9)) * 0.045; }                 // typing: quick small bounce
    if (st === 'long') { tilt = Math.sin(t * 2) * 0.05; }
    if (st === 'compacting') { tilt = Math.sin(t * 4) * 0.16; shakeX = Math.sin(t * 4) * 0.05; }   // sweeping back and forth
    if (st === 'juggling') { lift = Math.abs(Math.sin(t * 3)) * 0.04; }
    if (st === 'asking') { lift = Math.max(0, Math.sin(t * 6)) * 0.2; shakeX = Math.sin(t * 40) * 0.012; }
    if (st === 'done') { const p = Math.min(1, since / 700); lift = Math.sin(p * Math.PI) * 0.2; }
    if (st === 'failed') { shakeX = Math.sin(t * 30) * 0.04 * Math.max(0.15, 1 - since / 900); }
    if (poked) { const p = 1 - (a.pokeUntil - now) / 520; lift = Math.sin(p * Math.PI) * 0.16; }
    if (annoyed) tilt = -0.18;
    if (yawning) scale = 1 + Math.sin(Math.min(1, since / 1800) * Math.PI) * 0.07;
    if (waking) scale = 1 + Math.sin(since / 900 * Math.PI) * 0.1;
  }
  if (st === 'asking') scale *= 1.08;

  if (k > 0.02 && !rest) {
    ctx.globalAlpha = k; ctx.fillStyle = colors.shadow;
    ctx.beginPath(); ctx.ellipse(cx, cy + L * 0.52, L * (0.34 - lift * 0.6), L * 0.05, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.save();
  ctx.translate(cx + shakeX * L, cy - lift * L);
  ctx.rotate(tilt);
  ctx.scale(scale, scale);
  const img = logoImage(id);
  if (m.bot && img && img.complete && img.naturalWidth) {
    ctx.globalAlpha = st === 'asleep' && !yawning ? 0.55 : st === 'limited' ? 0.4 : 1;
    ctx.drawImage(img, -L / 2, -L / 2, L, L);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = colors[id]; ctx.beginPath(); ctx.arc(0, 0, L * 0.46, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = colors.ink; ctx.font = `600 ${L * 0.42}px ${font}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(m.short, 0, L * 0.03);
  }

  // eyes
  const E = EYES[id];
  if (E && k > 0.02) {
    const u = L / 24;
    ctx.translate(-L / 2, -L / 2);
    ctx.globalAlpha = k;
    let gx = 0, gy = 0;
    if (!still) {
      if (st === 'thinking') { gx = Math.sin(t * 1.1) * 0.35; gy = -0.3; }
      else if (st === 'tool' || st === 'long') { gy = 0.35; gx = Math.sin(t * 2.2) * 0.15; }   // eyes on the keyboard
      else if (idlePeek && !hovering) { gx = Math.sin((now - a.peekUntil) / 400) * 0.4; }      // glancing around
      else if (now - pointer.at < 6000) {
        const r = cv.getBoundingClientRect();
        const dx = pointer.x - (r.left + r.width * 0.44), dy = pointer.y - (r.top + r.height * 0.57);
        const d = Math.hypot(dx, dy) || 1, f = Math.min(1, d / 260);
        gx = dx / d * 0.4 * f; gy = dy / d * 0.3 * f;
      }
    }
    if (E.holes) { gx = Math.max(-0.15, Math.min(0.15, gx)); gy = Math.max(-0.4, Math.min(0.4, gy)); }
    let open = 1;
    if (!still && now > a.blinkAt) { const p = (now - a.blinkAt) / 140; if (p >= 1) a.blinkAt = now + 2200 + Math.random() * 3800; else open = Math.max(0.1, Math.abs(1 - p * 2)); }
    if (yawning) open = Math.max(0.08, 1 - since / 1500);
    let face = 'pill';
    if (st === 'done') face = since < 1300 ? 'heart' : 'happy';
    else if (st === 'failed') face = 'x';
    else if (annoyed) face = 'flat';
    else if (poked) face = 'squint';
    let w = E.w, h = E.h;
    if (st === 'tool' || st === 'long' || st === 'compacting') h *= 0.6;
    if (st === 'asking') { w *= 1.1; h *= 1.12; }
    let ink = id === 'claude' ? '#000000' : '#15171b';
    let halo = id === 'claude' ? null : '#ffffff';
    if (E.plate) {
      const light = isLight();
      ctx.fillStyle = light ? '#24282e' : '#d6d9de';
      ctx.beginPath(); ctx.arc(12 * u, 12 * u, E.plate * u, 0, Math.PI * 2); ctx.fill();
      ink = light ? '#ffffff' : '#16181b'; halo = null;
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    E.x.forEach((ex0, side) => {
      const ex = (ex0 + gx) * u, ey = (E.y + gy) * u;
      const r = Math.max(E.w, 1.4) * 0.6 * u;
      const path = new Path2D();
      if (face === 'pill') {
        const hh = Math.max(0.3, h * open) * u, ww = w * u;
        if (path.roundRect) path.roundRect(ex - ww / 2, ey - hh / 2, ww, hh, ww / 2); else path.rect(ex - ww / 2, ey - hh / 2, ww, hh);
        if (!E.holes && halo) { ctx.strokeStyle = halo; ctx.lineWidth = 0.7 * u; ctx.stroke(path); }
        ctx.fillStyle = ink; ctx.fill(path);
        return;
      }
      if (face === 'heart') {
        const hr = r * 0.62, hy = ey - r * 0.1;
        path.moveTo(ex, hy + hr * 1.5);
        path.bezierCurveTo(ex - hr * 2.2, hy + hr * 0.2, ex - hr * 1.1, hy - hr * 1.5, ex, hy - hr * 0.3);
        path.bezierCurveTo(ex + hr * 1.1, hy - hr * 1.5, ex + hr * 2.2, hy + hr * 0.2, ex, hy + hr * 1.5);
        if (halo) { ctx.strokeStyle = halo; ctx.lineWidth = 0.7 * u; ctx.stroke(path); }
        ctx.fillStyle = colors.danger; ctx.fill(path);
        return;
      }
      if (face === 'happy') { path.moveTo(ex - r, ey + r * 0.4); path.quadraticCurveTo(ex, ey - r * 1.3, ex + r, ey + r * 0.4); }
      else if (face === 'x') { path.moveTo(ex - r, ey - r); path.lineTo(ex + r, ey + r); path.moveTo(ex + r, ey - r); path.lineTo(ex - r, ey + r); }
      else if (face === 'flat') { path.moveTo(ex - r, ey); path.lineTo(ex + r, ey); }
      else if (face === 'squint') { const d = side ? -1 : 1; path.moveTo(ex - r * d, ey - r * 0.8); path.lineTo(ex + r * d, ey); path.lineTo(ex - r * d, ey + r * 0.8); }   // > <
      if (halo) { ctx.strokeStyle = halo; ctx.lineWidth = 1.5 * u; ctx.stroke(path); }
      ctx.strokeStyle = ink; ctx.lineWidth = 0.8 * u; ctx.stroke(path);
    });
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (!m.bot) return;

  drawProps(ctx, a, st, { W, L, cx, cy, lift, t, still, since, s0, yawning, now });
}

/* ---- props: clear, recognisable objects (style reference: Clawd on Desk; drawn from scratch) ---- */
const PAL = () => isLight()
  ? { paper: '#ffffff', paperLine: '#cfd4da', dot: '#9aa0a9', kb: '#3a3f47', key: '#5b616b', wood: '#9a6a3c', straw: '#d9a43c', cloud: '#8b919b', gold: '#e0a020', red: '#d04848' }
  : { paper: '#eef0f3', paperLine: '#eef0f3', dot: '#8b919b', kb: '#2b2f36', key: '#4a505a', wood: '#b07c4a', straw: '#e8b54c', cloud: '#7d838d', gold: '#f2c14e', red: '#e06c6c' };
function star(ctx, x, y, r, color) {
  ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, rr = i % 2 ? r * 0.32 : r; ctx.lineTo(x + Math.sin(a) * rr, y - Math.cos(a) * rr); }
  ctx.closePath(); ctx.fill();
}
function drawProps(ctx, a, st, o) {
  const { W, L, cx, cy, lift, t, still, since, s0, yawning } = o;
  const P = PAL();
  const R = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); };
  const headY = cy - L * 0.5 - lift * L;           // top of the logo
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  if (st === 'thinking') {
    // white thought bubble with three dots, two trailing puffs toward the head
    const bw = W * 0.4, bh = W * 0.22, bx = W * 0.57, by = W * 0.03 + (still ? 0 : Math.sin(t * 2) * W * 0.01);
    ctx.fillStyle = P.paper; ctx.strokeStyle = P.paperLine; ctx.lineWidth = Math.max(1, W * 0.012);
    R(bx, by, bw, bh, bh / 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(bx + bw * 0.12, by + bh * 1.25, W * 0.028, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(bx - W * 0.01, by + bh * 1.7, W * 0.016, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const lit = still ? 1 : Math.floor(t * 3.2) % 3;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i === lit ? colors.accent : P.dot;
      ctx.beginPath(); ctx.arc(bx + bw * (0.27 + i * 0.23), by + bh / 2 - (i === lit && !still ? W * 0.012 : 0), W * 0.026, 0, Math.PI * 2); ctx.fill();
    }
  }

  if (st === 'tool') {
    // a small keyboard in front, keys lighting up as it types
    const kw = L * 0.95, kh = L * 0.24, kx = cx - kw / 2, ky = cy + L * 0.36;
    ctx.fillStyle = P.kb; R(kx, ky, kw, kh, kh * 0.25); ctx.fill();
    const cols = 7, rows = 2, gap = kw * 0.025, kwid = (kw - gap * (cols + 1)) / cols, khei = (kh - gap * (rows + 1)) / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const on = !still && (Math.floor(t * 11) * 7 + 3) % (cols * rows) === r * cols + c;
      ctx.fillStyle = on ? colors.accent : P.key;
      R(kx + gap + c * (kwid + gap), ky + gap + r * (khei + gap), kwid, khei, khei * 0.25); ctx.fill();
    }
  }

  if (st === 'long') {
    // hourglass that drains, then flips
    const hx = W * 0.82, hy = W * 0.17, hw = W * 0.15, hh = W * 0.24;
    const cyc = still ? 0.4 : (t % 4) / 4;
    const flip = cyc > 0.85 ? (cyc - 0.85) / 0.15 : 0;
    const level = Math.min(1, cyc / 0.85);
    ctx.translate(hx, hy); ctx.rotate(flip * Math.PI);
    ctx.fillStyle = P.wood; R(-hw / 2 - W * 0.01, -hh / 2 - W * 0.02, hw + W * 0.02, W * 0.025, W * 0.01); ctx.fill(); R(-hw / 2 - W * 0.01, hh / 2 - W * 0.005, hw + W * 0.02, W * 0.025, W * 0.01); ctx.fill();
    ctx.fillStyle = P.paper; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(-hw / 2, -hh / 2); ctx.lineTo(hw / 2, -hh / 2); ctx.lineTo(0, 0); ctx.lineTo(hw / 2, hh / 2); ctx.lineTo(-hw / 2, hh / 2); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = P.straw;
    const top = (1 - level) * 0.9, bot = level * 0.9;
    ctx.beginPath(); ctx.moveTo(-hw / 2 * top, -hh / 2 * top); ctx.lineTo(hw / 2 * top, -hh / 2 * top); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-hw / 2 * 0.9, hh / 2 * 0.9); ctx.lineTo(hw / 2 * 0.9, hh / 2 * 0.9); ctx.lineTo(hw / 2 * 0.9 * (1 - bot * 0.6), hh / 2 * 0.9 * (1 - bot)); ctx.lineTo(-hw / 2 * 0.9 * (1 - bot * 0.6), hh / 2 * 0.9 * (1 - bot)); ctx.closePath(); ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  if (st === 'compacting') {
    // a broom sweeping beside the bot, dust puffs flying off
    const sw = still ? 0.2 : Math.sin(t * 4) * 0.35;
    ctx.translate(cx - L * 0.5, cy + L * 0.5); ctx.rotate(-0.55 + sw);
    ctx.strokeStyle = P.wood; ctx.lineWidth = Math.max(1.5, W * 0.03);
    ctx.beginPath(); ctx.moveTo(0, -L * 0.75); ctx.lineTo(0, 0); ctx.stroke();
    ctx.fillStyle = P.straw; ctx.beginPath(); ctx.moveTo(-W * 0.06, 0); ctx.lineTo(W * 0.06, 0); ctx.lineTo(W * 0.09, W * 0.11); ctx.lineTo(-W * 0.09, W * 0.11); ctx.closePath(); ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < 3; i++) {
      const p = still ? i / 3 : (t * 0.8 + i / 3) % 1;
      ctx.globalAlpha = (1 - p) * 0.8; ctx.fillStyle = P.cloud;
      ctx.beginPath(); ctx.arc(cx - L * 0.55 - p * W * 0.25, cy + L * 0.62 - Math.sin(p * Math.PI) * W * 0.12, W * (0.02 + p * 0.03), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  if (st === 'juggling') {
    // the lead juggles one ball per running task, coloured by who is doing it
    const balls = a.fixed ? ['codex', 'claude', 'grok', 'gemini'] : a.balls;
    const n = Math.max(1, Math.min(5, balls.length));
    for (let i = 0; i < n; i++) {
      const ph = (still ? 0.7 : t * 2.4) + i * (Math.PI * 2 / n);
      const x = cx + Math.cos(ph) * L * 0.5, y = Math.max(W * 0.07, headY - W * 0.02 - Math.max(0, Math.sin(ph)) * W * 0.17);
      ctx.fillStyle = colors[balls[i]] || colors.accent;
      ctx.beginPath(); ctx.arc(x, y, Math.max(2, W * 0.055), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.arc(x - W * 0.017, y - W * 0.017, Math.max(0.8, W * 0.016), 0, Math.PI * 2); ctx.fill();
    }
  }

  if (st === 'asking') {
    // an orange notification badge with "!", bouncing and ringing
    const r = W * 0.12, bx = W * 0.8, by = W * 0.2 - (still ? 0 : Math.max(0, Math.sin(t * 6)) * W * 0.05);
    if (!still) {
      const ring = (t * 1.6) % 1;
      ctx.strokeStyle = colors.warn; ctx.globalAlpha = 1 - ring; ctx.lineWidth = Math.max(1, W * 0.015);
      ctx.beginPath(); ctx.arc(bx, by, r * (1 + ring * 0.7), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.fillStyle = colors.warn; ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; R(bx - r * 0.13, by - r * 0.6, r * 0.26, r * 0.72, r * 0.13); ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by + r * 0.45, r * 0.15, 0, Math.PI * 2); ctx.fill();
  }

  if (st === 'failed') {
    // a small storm cloud with a flashing bolt
    const x0 = W * 0.64, y0 = W * 0.06;
    ctx.fillStyle = P.cloud;
    ctx.beginPath(); ctx.arc(x0 + W * 0.08, y0 + W * 0.1, W * 0.07, 0, Math.PI * 2); ctx.arc(x0 + W * 0.17, y0 + W * 0.07, W * 0.09, 0, Math.PI * 2); ctx.arc(x0 + W * 0.26, y0 + W * 0.11, W * 0.065, 0, Math.PI * 2); ctx.fill();
    R(x0 + W * 0.04, y0 + W * 0.1, W * 0.27, W * 0.08, W * 0.04); ctx.fill();
    if (still || Math.floor(t * 5) % 3 !== 0) {
      ctx.fillStyle = P.gold; ctx.beginPath();
      const bx = x0 + W * 0.16, by = y0 + W * 0.17;
      ctx.moveTo(bx, by); ctx.lineTo(bx - W * 0.05, by + W * 0.09); ctx.lineTo(bx, by + W * 0.09); ctx.lineTo(bx - W * 0.03, by + W * 0.17); ctx.lineTo(bx + W * 0.05, by + W * 0.06); ctx.lineTo(bx + W * 0.005, by + W * 0.06); ctx.lineTo(bx + W * 0.03, by); ctx.closePath(); ctx.fill();
    }
  }

  if (st === 'done' && since < 2200) {
    // sparkles popping around the head
    const p = still ? 0.5 : since / 2200;
    [[0.12, 0.22, 0], [0.82, 0.12, 0.15], [0.9, 0.5, 0.3], [0.2, 0.6, 0.45]].forEach(([fx, fy, d]) => {
      const q = Math.max(0, Math.min(1, (p - d) / 0.5));
      if (q <= 0) return;
      ctx.globalAlpha = Math.sin(q * Math.PI);
      star(ctx, W * fx, W * fy - q * W * 0.06, W * (0.05 + Math.sin(q * Math.PI) * 0.035), P.gold);
    });
    ctx.globalAlpha = 1;
  }

  if (st === 'limited') {
    const bx = W * 0.74, by = W * 0.05, bw = W * 0.2, bh = W * 0.11;
    ctx.strokeStyle = colors.warn; ctx.lineWidth = Math.max(1, W * 0.02);
    R(bx, by, bw, bh, W * 0.02); ctx.stroke();
    ctx.fillStyle = colors.warn; R(bx + bw, by + bh * 0.3, W * 0.025, bh * 0.4, W * 0.008); ctx.fill();
    ctx.fillStyle = P.red; R(bx + W * 0.025, by + W * 0.025, bw * 0.18, bh - W * 0.05, W * 0.01); ctx.fill();
  }

  if (st === 'asleep' && !yawning) {
    ctx.fillStyle = colors.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 3; i++) {
      const p = still ? i / 3 : (t * 0.35 + i / 3) % 1;
      ctx.globalAlpha = still ? 0.85 : Math.sin(p * Math.PI);
      ctx.font = `700 ${Math.round(W * (0.11 + p * 0.1))}px ${font}`;
      ctx.fillText('z', W * (0.7 + p * 0.16), W * (0.32 - p * 0.24));
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawAll(force) {
  const now = performance.now();
  for (const [cv, a] of avatars) {
    if (!cv.isConnected) { avatars.delete(cv); continue; }
    if (force || (!a.still && !reduceMotion.matches && cv.getClientRects().length)) drawBot(a, now);
  }
}

function stop() {
  cancelAnimationFrame(frame);
  frame = undefined;
}

function animate(now) {
  if (now - lastFrame > 30) {
    drawAll(false);
    lastFrame = now;
  }
  frame = requestAnimationFrame(animate);
}

function syncPlayback() {
  stop();
  if (!document.hidden && document.hasFocus() && !reduceMotion.matches && avatars.size) frame = requestAnimationFrame(animate);
}

function scan(records) {
  let changed = false;
  for (const mutation of records) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const canvases = node.matches('canvas[data-avatar-state]') ? [node] : node.querySelectorAll('canvas[data-avatar-state]');
      for (const cv of canvases) {
        if (!cv.isConnected || avatars.has(cv)) continue;
        drawBot(track(cv), performance.now());
        changed = true;
      }
    }
  }
  for (const cv of avatars.keys()) if (!cv.isConnected) avatars.delete(cv);
  if (changed || !avatars.size) syncPlayback();
}

readColors();
new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
new MutationObserver(() => { readColors(); drawAll(true); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
window.addEventListener('pointermove', (event) => Object.assign(pointer, { x: event.clientX, y: event.clientY, at: performance.now() }), { passive: true });
window.addEventListener('focus', syncPlayback);
window.addEventListener('blur', stop);
document.addEventListener('visibilitychange', syncPlayback);
reduceMotion.addEventListener('change', () => { drawAll(true); syncPlayback(); });

window.AgentDeskAvatars = { html, states: STATES, previewStates: SHEET_ORDER, members: M };
})();
