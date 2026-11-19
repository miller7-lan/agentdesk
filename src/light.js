// Lancer Light UI (MIT, src/vendor/light-ui) in AgentDesk: a flowing outline on work that is running, and a
// light that flies from a member's closing summary to its row on the progress board when it finishes.
(() => {
  const ui = window.LancerLightUI;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Each member's own colour, read from the theme so it follows light and dark mode.
  const colour = (role) => getComputedStyle(document.documentElement).getPropertyValue('--member-' + (role === 'claude' ? 'lead' : role)).trim() || '#70a7f7';
  const border = (role) => `<svg class="light-running-border" style="--light-color:${colour(role)}" aria-hidden="true"><rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="9" pathLength="100"/></svg>`;

  let layer;
  const seen = new Map();   // step key -> last state seen
  let primed = false;
  function completed(root, steps) {
    const fresh = [];
    for (const { key, state, role } of steps) {
      const before = seen.get(key);
      seen.set(key, state);
      if (primed && before && before !== 'completed' && state === 'completed') fresh.push({ key, role });
    }
    primed = true;   // nothing flies for work that was already done when the window opened
    if (!fresh.length || !ui || reduce.matches || document.hidden) return;
    layer ||= ui.createLightLayer();
    requestAnimationFrame(() => {
      for (const { key, role } of fresh) {
        const source = root.querySelector(`[data-flight-from="${CSS.escape(key)}"]`);
        if (!source) continue;
        // A summary scrolled out of sight would send a light from nowhere; the node still fills in on render.
        const seen = source.getBoundingClientRect();
        const view = root.getBoundingClientRect();
        if (seen.bottom < view.top || seen.top > view.bottom) continue;
        // Every node of that step gets a light: its row on the progress board and, when the dispatch graph is
        // open, its node there. Targets are looked up on each frame, so a re-render does not lose them.
        // ...and the task's node on the project lanes, when they are open.
        const selector = `[data-flight-to="${CSS.escape(key)}"], [data-flight-task="${CSS.escape(key.split(':')[0])}"]`;
        const targets = document.querySelectorAll(selector);
        // A node further down the lane tree is brought into view first, so the light lands where it can be seen.
        targets.forEach((target) => { if (target.closest('.lane-tree')) target.scrollIntoView({ block: 'nearest' }); });
        targets.forEach((_, index) => {
          const find = () => document.querySelectorAll(selector)[index];
          try {
            const flight = layer.emit({ id: key + ':' + index + ':' + Date.now(), source, target: find, color: colour(role) });
            flight.finished.then((result) => {
              if (result !== 'arrived') return;
              const node = find();
              arrive(node);
              // The line stays on the lane tree's node (or the progress board row) until that node is clicked.
              const scope = node?.closest('.lane-tree') ? '.lane-tree ' : node?.closest('.step-board') ? '.step-board ' : '';
              // On the lane tree the line takes the task line's own colour, like the lane it joins.
              const laneColour = node?.style.getPropertyValue('--lane').trim();
              if (scope && node.dataset.flightTo) keep(`[data-flight-from="${CSS.escape(key)}"]`, `${scope}[data-flight-to="${CSS.escape(key)}"]`, laneColour || colour(role));
            });
          } catch { /* a duplicate id is harmless */ }
        });
      }
    });
  }

  // ---------- lasting flow lines ----------
  // After a member's light lands, a flow line stays between its summary and the node it reached, until the
  // person clicks that node. Lines are kept by selector (the page re-renders), on this computer across restarts,
  // and drawn only while both ends are in view inside their scrolling panes.
  const LINKS_KEY = 'agentdesk.lightLinks';
  const links = new Map(Object.entries((() => { try { return JSON.parse(localStorage.getItem(LINKS_KEY) || '{}'); } catch { return {}; } })()));
  const saveLinks = () => { try { localStorage.setItem(LINKS_KEY, JSON.stringify(Object.fromEntries([...links].slice(-60)))); } catch { /* storage may be unavailable */ } };
  let overlay;
  let drawing = false;
  function visibleRect(element) {
    if (!element || !element.isConnected) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden)/.test(style.overflowY) && parent.clientHeight < parent.scrollHeight) {
        const box = parent.getBoundingClientRect();
        if (rect.bottom < box.top || rect.top > box.bottom || rect.right < box.left || rect.left > box.right) return null;
      }
    }
    return rect;
  }
  function draw() {
    drawing = false;
    if (!links.size) { overlay?.remove(); overlay = null; return; }
    if (!overlay) {
      overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      overlay.setAttribute('class', 'light-links');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
    }
    // Each line keeps its own elements and only its geometry is updated, so the dashes keep flowing and the
    // light keeps travelling from the summary to the node without restarting on every scroll or re-render.
    const seen = new Set();
    for (const [id, link] of links) {
      const from = visibleRect(document.querySelector(link.from));
      const to = visibleRect(document.querySelector(link.to));
      if (!from || !to) continue;
      const rightward = to.left > from.right;
      const x1 = rightward ? from.right : from.left + from.width / 2;
      const y1 = rightward ? from.top + from.height / 2 : from.top;
      const x2 = rightward ? to.left + 6 : to.left + to.width / 2;
      const y2 = to.top + to.height / 2;
      const bend = Math.max(40, Math.abs(x2 - x1) * 0.45);
      const d = rightward ? `M${x1} ${y1} C${x1 + bend} ${y1},${x2 - bend} ${y2},${x2} ${y2}` : `M${x1} ${y1} C${x1} ${y1 - bend},${x2} ${y2 + bend},${x2} ${y2}`;
      let group = overlay.querySelector(`[data-link="${CSS.escape(id)}"]`);
      if (!group) {
        group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.dataset.link = id;
        group.style.setProperty('--link', link.color);
        group.innerHTML = '<path class="ll-glow"/><path class="ll-dash"/><circle class="ll-end" r="2.8"/><circle class="ll-spark" r="3"/>';
        overlay.appendChild(group);
      }
      for (const path of group.querySelectorAll('path')) if (path.getAttribute('d') !== d) path.setAttribute('d', d);
      const end = group.querySelector('.ll-end');
      end.setAttribute('cx', x2); end.setAttribute('cy', y2);
      group.querySelector('.ll-spark').style.offsetPath = `path("${d}")`;
      group.style.display = '';
      seen.add(id);
    }
    // Lines whose ends are out of view are hidden, not removed; lines that were cleared go away.
    for (const group of overlay.querySelectorAll('g[data-link]')) {
      if (!links.has(group.dataset.link)) group.remove();
      else if (!seen.has(group.dataset.link)) group.style.display = 'none';
    }
  }
  function schedule() { if (!drawing) { drawing = true; requestAnimationFrame(draw); } }
  function keep(from, to, color) {
    links.set(from + '→' + to, { from, to, color });
    saveLinks();
    schedule();
  }
  // Clicking the node a line ends at clears that line.
  document.addEventListener('click', (event) => {
    let changed = false;
    for (const [id, link] of links) {
      if (event.target.closest?.(link.to)) { links.delete(id); changed = true; }
    }
    if (changed) { saveLinks(); schedule(); }
  }, true);
  // Redrawn when something moves: scrolling any pane, resizing, or the page re-rendering.
  window.addEventListener('scroll', () => { if (links.size) schedule(); }, true);
  window.addEventListener('resize', () => { if (links.size) schedule(); });
  new MutationObserver((records) => {
    // the flow-line layer redrawing itself is not a change worth redrawing for
    if (!links.size || records.every((record) => overlay && (record.target === overlay || overlay.contains(record.target)))) return;
    schedule();
  }).observe(document.body, { childList: true, subtree: true });
  if (links.size) schedule();

  // The node lights up when the light reaches it: its dot fills and a ring spreads out once.
  function arrive(node) {
    if (!node) return;
    node.classList.remove('light-arrived');
    void node.offsetWidth;   // restart the animation
    node.classList.add('light-arrived');
    setTimeout(() => node.classList.remove('light-arrived'), 1400);
  }

  // One light from an element to another (a list row to its node on the lane tree), then the node lights up.
  function fly(source, target, color) {
    if (!source || !target) return;
    if (!ui || reduce.matches) { arrive(target); return; }
    layer ||= ui.createLightLayer();
    try {
      layer.emit({ id: 'fly:' + Date.now() + Math.random(), source, target, color: color || colour('lead'), duration: 900 })
        .finished.then((result) => { if (result === 'arrived') arrive(target); });
    } catch { arrive(target); }
  }

  window.AgentDeskLight = { border, completed, colour, arrive, fly };
})();
