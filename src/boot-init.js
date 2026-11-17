(function () {
  const launch = window.desk?.launch;
  let play = Boolean(launch?.id && launch.boot !== 'off');
  if (play) {
    try { play = JSON.parse(localStorage.getItem('agentdesk.appearance'))?.boot !== 'off'; } catch {}
  }
  if (play) {
    try {
      const key = 'agentdesk.boot.' + launch.id;
      play = !sessionStorage.getItem(key);
      if (play) sessionStorage.setItem(key, '1');
    } catch {}
  }
  const root = document.documentElement;
  root.dataset.bootplay = play ? 'yes' : 'no';
  if (play) root.dataset.boot = 'playing';
})();
