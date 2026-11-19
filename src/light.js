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
        const target = root.querySelector(`[data-flight-to="${CSS.escape(key)}"]`);
        if (!source || !target) continue;
        try { layer.emit({ id: key + ':' + Date.now(), source, target, color: colour(role) }); } catch { /* a duplicate id is harmless */ }
      }
    });
  }

  window.AgentDeskLight = { border, completed, colour };
})();
