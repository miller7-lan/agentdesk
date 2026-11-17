(async () => {
  const api = window.desk?.enrollment;
  if (!api || !await api.required()) return;
  const dialog = document.getElementById('enrollmentDialog');
  const form = document.getElementById('enrollmentForm');
  const input = document.getElementById('enrollmentPassword');
  const button = document.getElementById('enrollmentSubmit');
  const status = document.getElementById('enrollmentStatus');
  const messages = {
    invalid_password: '密码错误。',
    try_later: '尝试次数过多，请几分钟后再试。',
    enrollment_failed: '服务器暂时无法登记设备，请稍后重试。',
  };
  const show = (message = '') => {
    status.textContent = message;
    if (!dialog.open) dialog.showModal();
    input.focus();
  };
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  api.onExpired(async () => {
    const setup = await window.desk.onboarding?.status();
    if (!setup?.enabled || setup.complete || setup.confirmed) show('连接已过期，请重新输入密码。');
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = input.value;
    input.value = '';
    input.disabled = button.disabled = true;
    status.textContent = '正在连接…';
    try {
      const answer = await api.login(password);
      if (!answer.ok) throw Error(answer.error);
      dialog.close();
      window.dispatchEvent(new Event('agentdesk:enrollment-complete'));
    } catch (error) {
      status.textContent = messages[error.message] || '无法连接登录服务。';
    } finally {
      input.disabled = button.disabled = false;
      if (dialog.open) input.focus();
    }
  });
  window.AgentDeskEnrollment = { show };
  window.dispatchEvent(new Event('agentdesk:enrollment-ready'));
  const setup = await window.desk.onboarding?.status();
  if ((!setup?.enabled || setup.complete) && !await api.ready()) show();
})();
