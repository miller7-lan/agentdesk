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
        targets.forEach((_, index) => {
          const find = () => document.querySelectorAll(selector)[index];
          try {
            const flight = layer.emit({ id: key + ':' + index + ':' + Date.now(), source, target: find, color: colour(role) });
            flight.finished.then((result) => { if (result === 'arrived') arrive(find()); });
          } catch { /* a duplicate id is harmless */ }
        });
      }
    });
  }

  // The node lights up when the light reaches it: its dot fills and a ring spreads out once.
  function arrive(node) {
    if (!node) return;
    node.classList.remove('light-arrived');
    void node.offsetWidth;   // restart the animation
    node.classList.add('light-arrived');
    setTimeout(() => node.classList.remove('light-arrived'), 1400);
  }

  window.AgentDeskLight = { border, completed, colour, arrive };
})();
