(function () {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const boot = $('boot');
  const canvas = $('bootCanvas');
  const ctx = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const feed = window.AgentDeskBootFeed;
  const actions = $('bootActions');
  const nodeLayer = $('bootNodes');
  const timeLimit = 5;
  const blue = '#2f6fe0';
  const amber = '#a3660a';
  const turn = Math.PI * 2;
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const ease = (value) => 1 - (1 - clamp(value)) ** 3;
  let run;
  let exitTimer;

  function finish(fade = false) {
    if (!run) return;
    cancelAnimationFrame(run.frame);
    clearTimeout(run.timer);
    run.cancelChecks();
    run = null;
    const hide = () => {
      root.dataset.bootplay = 'no';
      delete root.dataset.boot;
      boot.classList.remove('leaving');
      nodeLayer.replaceChildren();
      $('input')?.focus({ preventScroll: true });
    };
    if (fade && !motion.matches) {
      boot.classList.add('leaving');
      exitTimer = setTimeout(hide, 700);
    } else hide();
  }

  function arc(x, y, radius, start, end) {
    ctx.beginPath();
    ctx.arc(x, y, radius, start, end);
    ctx.stroke();
  }

  function layout(width, height, nodes) {
    const x = width / 2;
    const y = height * 0.39;
    const rx = Math.min(width * 0.34, height * 0.51);
    const ry = height * 0.21;
    const points = new Map([['lead', { x, y }]]);
    const outer = nodes.filter((node) => node.id !== 'lead').sort((a, b) => a.order - b.order);
    outer.forEach(({ id }, index) => {
      const angle = [-Math.PI, -2.4, -Math.PI / 2, -0.74, 0][index];
      points.set(id, { x: x + rx * Math.cos(angle), y: y + ry * Math.sin(angle) });
    });
    return { x, y, r: Math.min(height * 0.16, width * 0.15), wordY: height * 0.68, points };
  }

  function wordPoints(font) {
    const mask = document.createElement('canvas');
    const ink = mask.getContext('2d');
    ink.font = font;
    mask.width = Math.ceil(ink.measureText('AgentDesk').width) + 8;
    mask.height = 105;
    ink.font = font;
    ink.textAlign = 'center';
    ink.textBaseline = 'middle';
    ink.fillText('AgentDesk', mask.width / 2, mask.height / 2);
    const { data } = ink.getImageData(0, 0, mask.width, mask.height);
    const points = [];
    for (let y = 0; y < mask.height; y += 3) {
      for (let x = 0; x < mask.width; x += 3) {
        if (data[(y * mask.width + x) * 4 + 3] > 128) {
          points.push({ x: x - mask.width / 2, y: y - mask.height / 2, delay: Math.random() * 0.35 });
        }
      }
    }
    return points;
  }

  function draw(active, t, final = false) {
    const width = innerWidth;
    const height = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const { nodes, logs } = active.data;
    const { x, y, r, points, wordY } = layout(width, height, nodes);

    // 蓝图基准线、环形刻度与扫描光。
    ctx.strokeStyle = '#2f6fe030';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    const rings = ease((t - 0.25) / 1);
    ctx.setLineDash([2, 5]);
    arc(x, y, r * 0.58, t * 0.4, t * 0.4 + turn * rings);
    ctx.setLineDash([]);
    arc(x, y, r, 0, turn * rings);
    ctx.strokeStyle = '#2f6fe080';
    ctx.beginPath();
    for (let i = 0; i < 120 * rings; i++) {
      const angle = i * turn / 120;
      const outer = r * 0.8;
      const inner = outer - (i % 10 === 0 ? 8 : 4);
      ctx.moveTo(x + inner * Math.cos(angle), y + inner * Math.sin(angle));
      ctx.lineTo(x + outer * Math.cos(angle), y + outer * Math.sin(angle));
    }
    ctx.stroke();
    ctx.strokeStyle = blue;
    for (let i = 0; i < 3; i++) {
      const start = i * turn / 3 - t * 0.9;
      arc(x, y, r * 0.89, start, start + rings * 0.53);
    }
    if (t < 1.3) {
      const scan = height * ease(t / 1.3);
      const glow = ctx.createLinearGradient(0, scan - 40, 0, scan);
      glow.addColorStop(0, '#2f6fe000');
      glow.addColorStop(1, '#2f6fe044');
      ctx.fillStyle = glow;
      ctx.fillRect(0, scan - 40, width, 40);
    }

    // 检查完成后连线，再显示节点及它的状态。
    for (const node of nodes) {
      const p = points.get(node.id);
      const at = node.at;
      const progress = final ? 1 : ease((t - at) / 0.25);
      const lead = node.id === 'lead';
      const color = node.kind === 'ok' ? blue : amber;
      if (!lead && progress > 0) {
        const dx = p.x - x;
        const dy = p.y - y;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + dx * progress, y + dy * progress);
        ctx.stroke();
        if (progress === 1) {
          arc(p.x, p.y, 27, 0, turn);
          const packet = final ? 0.6 : ((t - at) * 1.35) % 1;
          ctx.fillStyle = color;
          ctx.fillRect(x + dx * packet - 2, y + dy * packet - 2, 4, 4);
        }
      }
      if (lead || progress > 0.75) updateNode(active, node, p, lead);
    }

    if (t > 3) {
      const font = `700 ${Math.min(width * 0.11, 82)}px system-ui`;
      if (active.font !== font) {
        active.font = font;
        active.particles = wordPoints(font);
      }
      const solid = ease((t - 3.95) / 0.6);
      const sources = [...points.values()];
      ctx.fillStyle = blue;
      ctx.globalAlpha = (1 - solid) * 0.8;
      active.particles.forEach((particle, index) => {
        const source = sources[index % sources.length];
        const p = ease((t - 3 - particle.delay) / 1);
        ctx.fillRect(source.x + (x + particle.x - source.x) * p, source.y + (wordY + particle.y - source.y) * p, 2, 2);
      });
      ctx.globalAlpha = solid;
      ctx.fillStyle = '#13294b';
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AgentDesk', x, wordY);
      ctx.globalAlpha = 1;
    }

    const lines = logs.filter((item) => item.at <= t).slice(-6);
    const logText = lines.map(({ name, status }) => '> ' + name + ' · ' + status).join('\n');
    if ($('bootLog').textContent !== logText) $('bootLog').textContent = logText;
    $('bootClock').textContent = new Date().toTimeString().slice(0, 8);
  }

  function updateNode(active, node, { x, y }, lead) {
    let entry = active.elements.get(node.id);
    if (!entry) {
      const bot = document.createElement('div');
      bot.className = 'boot-node';
      bot.innerHTML = window.AgentDeskAvatars.html(node.id, {
        size: lead ? 66 : 46, key: 'boot:' + node.id,
        state: lead ? 'juggling' : node.kind === 'ok' ? 'done' : 'limited',
        still: active.quick,
      });
      const label = document.createElement('div');
      label.className = 'boot-label';
      const name = document.createElement('b');
      name.textContent = node.name;
      const status = document.createElement('span');
      label.append(name, status);
      nodeLayer.append(bot, label);
      entry = { bot, label, status };
      active.elements.set(node.id, entry);
    }
    entry.bot.style.left = entry.label.style.left = x + 'px';
    entry.bot.style.top = y + 'px';
    entry.label.style.top = y + (lead ? 38 : 31) + 'px';
    entry.label.style.opacity = '1';
    entry.status.className = node.kind;
    entry.status.textContent = node.role ? node.role + ' · ' + node.status : node.status;
  }

  function start() {
    finish();
    clearTimeout(exitTimer);
    boot.classList.remove('leaving');
    actions.hidden = true;
    nodeLayer.replaceChildren();
    root.dataset.bootplay = 'yes';
    root.dataset.boot = 'playing';
    $('bootBuild').textContent = 'V' + (window.desk.system.version || '');
    $('bootOs').textContent = { mac: 'MACOS', win: 'WINDOWS', linux: 'LINUX' }[window.desk.system.os] || '';
    $('bootSkip').focus({ preventScroll: true });
    const quick = motion.matches;
    const active = { quick, data: feed.buildBootData(), elements: new Map(), start: performance.now() };
    run = active;
    active.cancelChecks = feed.collect(window.desk, (data) => { active.data = data; });
    const end = () => {
      cancelAnimationFrame(active.frame);
      draw(active, timeLimit, true);
      if (active.data.offline) {
        actions.hidden = false;
        $('bootRetry').focus({ preventScroll: true });
      } else finish(true);
    };
    if (quick) draw(active, timeLimit, true);
    else {
      const frame = (now) => {
        draw(active, (now - active.start) / 1000);
        active.frame = requestAnimationFrame(frame);
      };
      active.frame = requestAnimationFrame(frame);
    }
    active.timer = setTimeout(end, quick ? 1000 : timeLimit * 1000);
  }

  window.__boot = {
    skip: () => finish(),
    replay: start,
    setEnabled(enabled) { if (!enabled) finish(); },
    isPlaying: () => root.dataset.boot === 'playing',
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
