(function () {
  'use strict';

  // A few large colour fields drifting slowly behind the glass. Drawn at 1/8 resolution and
  // scaled by CSS, capped at ~15 fps, and paused whenever it cannot be seen.
  const canvas = document.getElementById('fluid');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const BLOBS = [
    [0.25, 0.3, 0.55, 0, 0.11],
    [0.75, 0.25, 0.5, 40, 0.08],
    [0.6, 0.75, 0.6, -30, 0.09],
    [0.2, 0.8, 0.45, 70, 0.12],
    [0.5, 0.5, 0.35, 15, 0.07],
  ];
  let options = { skin: 'aqua', hue: 212, bright: 1 };
  let lastDraw = 0;
  let raf = 0;
  let running = false;

  const isLight = () => document.documentElement.dataset.theme !== 'dark';
  const bootPlaying = () => document.documentElement.dataset.boot === 'playing';
  function paused() {
    return options.skin !== 'aqua' || document.hidden || !document.hasFocus()
      || reduceMotion.matches || bootPlaying();
  }

  function frame(now, force = false) {
    if (!force && (paused() || now - lastDraw < 66)) return;
    lastDraw = now;
    const w = Math.max(64, Math.round(window.innerWidth / 8));
    const h = Math.max(64, Math.round(window.innerHeight / 8));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const light = isLight();
    const t = reduceMotion.matches ? 0 : now / 1000;
    const H = options.hue;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = light ? `hsl(${H} 40% 96%)` : `hsl(${H} 70% 5%)`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = light ? 'multiply' : 'screen';
    BLOBS.forEach(([x, y, radius, hueShift, speed], index) => {
      const cx = (x + Math.sin(t * speed + index * 1.7) * 0.18) * w;
      const cy = (y + Math.cos(t * speed * 1.3 + index) * 0.16) * h;
      const rr = radius * Math.max(w, h);
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      gradient.addColorStop(0, light
        ? `hsla(${H + hueShift} 80% 80% / .75)`
        : `hsla(${H + hueShift} 85% 42% / .75)`);
      gradient.addColorStop(1, light
        ? `hsla(${H + hueShift} 80% 90% / 0)`
        : `hsla(${H + hueShift} 85% 30% / 0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  function loop(now) {
    if (!running) return;
    frame(now);
    raf = window.requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    raf = window.requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    window.cancelAnimationFrame(raf);
  }
  function refresh() { frame(performance.now(), true); }
  function setOptions(next) {
    options = { ...options, ...(next || {}) };
    refresh();
  }

  window.addEventListener('resize', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
  reduceMotion.addEventListener?.('change', refresh);
  // The boot overlay sets data-boot on <html>; redraw once it finishes so the first visible
  // frame is correct even if the window never lost focus.
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-boot', 'data-theme'] });

  window.AgentDeskFluid = { start, stop, refresh, setOptions, frame };
  start();
  refresh();
})();