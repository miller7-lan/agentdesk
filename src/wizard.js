(function () {
  const desk = window.desk;
  if (!desk?.onboarding) return;
  const $ = (id) => document.getElementById(id);
  const dialog = $('onboardingDialog');
  const title = $('onboardingTitle');
  const content = $('onboardingContent');
  const status = $('onboardingStatus');
  const next = $('onboardingNext');
  const labels = {
    welcome: '欢迎使用 AgentDesk',
    fingerprint: '核对 SSH 主机指纹',
    login: '连接 AgentDesk',
    workspace: '选择项目工作区',
    checks: '检查主控和 CLI',
    appearance: '设置外观',
    complete: '设置完成',
  };
  const readiness = { ready: '已检测到 CLI', unavailable: 'CLI 不可用', quota_limited: '额度受限', auth_required: '需要登录' };
  let setup;
  let busy = false;
  let checks = null;
  let checking = false;

  function paragraph(text) {
    const node = document.createElement('p');
    node.textContent = text;
    content.append(node);
  }

  function button(label, action) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'btn';
    node.textContent = label;
    node.addEventListener('click', action);
    content.append(node);
  }

  async function refresh() {
    setup = await desk.onboarding.status();
    if (dialog.open) render();
  }

  async function runChecks() {
    if (checking) return;
    checking = true;
    checks = null;
    render();
    const results = await Promise.allSettled([
      desk.remote.status(), desk.orchestrator.control({ operation: 'onboarding_check' }),
      desk.orchestrator.control({ operation: 'quota_status' }),
    ]);
    checks = results.map((result) => result.status === 'fulfilled' ? result.value : null);
    checking = false;
    if (setup.step === 'checks' && dialog.open) render();
  }

  function render() {
    title.textContent = labels[setup.step];
    content.replaceChildren();
    next.disabled = busy;
    next.textContent = setup.step === 'complete' ? '完成' : '继续';
    if (setup.configurationError) {
      paragraph('配置文件无法读取，请修复后再运行向导。');
      next.disabled = true;
      return;
    }
    switch (setup.step) {
      case 'welcome':
        paragraph('设置连接、项目和外观。关闭后可从「工作区」继续。');
        break;
      case 'fingerprint':
        if (!setup.trust.host) {
          paragraph('尚未配置 SSH 主机。本次可继续设置本机工作区。');
          break;
        }
        paragraph(setup.trust.host);
        if (!setup.trust.fingerprints.length) {
          paragraph('请从管理员处取得 ed25519 主机公钥，经核验后加入已配置的 known_hosts，再重启 AgentDesk。');
          next.disabled = true;
          break;
        }
        paragraph('请与管理员提供的指纹核对，选择完全一致的一项。');
        for (const fingerprint of setup.trust.fingerprints) {
          const label = document.createElement('label');
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'onboardingFingerprint';
          radio.value = fingerprint;
          radio.addEventListener('change', () => { next.disabled = busy; });
          label.append(radio, document.createTextNode(fingerprint));
          content.append(label);
        }
        next.disabled = true;
        break;
      case 'login':
        if (setup.enrollmentRequired && !setup.signedIn) {
          next.disabled = true;
          paragraph('使用管理员提供的 AgentDesk 登记密码。');
          button('打开登录', () => window.AgentDeskEnrollment?.show());
        } else paragraph(setup.trust.host ? 'SSH 使用已配置的密钥和主机记录。' : '当前使用本机工作区。');
        break;
      case 'workspace':
        paragraph(setup.project ? [setup.project.name, setup.project.localRoot || setup.project.remoteCwd].filter(Boolean).join(' · ') : '请选择一个项目。');
        button('选择或配置工作区', () => window.AgentDeskProjects?.openSettings());
        break;
      case 'checks':
        if (!checks) {
          paragraph('正在检测连接、CLI 和额度…');
          if (!checking) runChecks();
          break;
        }
        paragraph('Codex SSH · ' + (checks[0]?.codex === 'ready' ? '已连接' : '未连接'));
        if (checks[1]?.ok && Array.isArray(checks[1].value)) {
          for (const { provider, state, version } of checks[1].value) {
            paragraph([provider, readiness[state] || '未知', version].filter(Boolean).join(' · '));
            if (state === 'auth_required' && ['codex', 'claude', 'grok', 'gemini', 'antigravity'].includes(provider)) {
              paragraph('请在主控终端运行 agent-tasks login ' + provider);
            }
          }
        } else paragraph('无法取得主控 CLI 检查结果。');
        if (checks[2]?.ok && Array.isArray(checks[2].value)) {
          const quota = checks[2].value.filter(({ used }) => Number.isFinite(used))
            .map(({ provider, used }) => `${provider} 剩余 ${Math.max(0, Math.min(100, Math.round(100 - used)))}%`);
          paragraph(quota.join(' · ') || '当前 CLI 没有提供额度读数。');
        } else paragraph('无法取得订阅额度。');
        button('重新检测', runChecks);
        break;
      case 'appearance':
        paragraph('可选择浅色或深色、Aqua 或经典皮肤，并关闭开机动画。');
        button('打开外观设置', () => $('appearanceBtn').click());
        break;
      case 'complete':
        paragraph('已保存设置，可以打开项目会话。');
        break;
    }
  }

  async function open(restart = false) {
    setup = await desk.onboarding.status();
    if (!setup.ok || !setup.enabled) return;
    if (restart && setup.complete) setup = await desk.onboarding.reset();
    if (!setup.ok || setup.complete) return;
    if (!dialog.open) dialog.showModal();
    render();
  }

  next.addEventListener('click', async () => {
    if (busy || !setup) return;
    const step = setup.step;
    const fingerprint = content.querySelector('input[name="onboardingFingerprint"]:checked')?.value;
    busy = next.disabled = true;
    status.textContent = '';
    try {
      const result = await (step === 'complete' ? desk.onboarding.complete() : desk.onboarding.advance({ step, fingerprint }));
      if (!result.ok) status.textContent = result.error || '无法保存设置。';
      else {
        setup = result;
        if (setup.complete) dialog.close();
      }
    } finally {
      busy = false;
      if (dialog.open) render();
    }
  });
  $('onboardingLater').addEventListener('click', () => dialog.close());
  $('onboardingOpen').addEventListener('click', () => {
    $('workspaceDialog').close();
    open(true);
  });
  desk.projects.onChanged(refresh);
  window.addEventListener('agentdesk:enrollment-complete', refresh);
  window.addEventListener('agentdesk:enrollment-ready', () => { if (setup?.step === 'login' && dialog.open) render(); });

  async function initial() {
    if (window.__boot?.isPlaying()) {
      setTimeout(initial, 200);
      return;
    }
    await open();
  }
  initial().catch(() => {});
})();
