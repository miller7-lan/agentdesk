// 独立 Bridge 的 SSH spawn 工厂：选路、拼参数、收集 stderr、把结果写回共享路由。
const { spawn } = require('node:child_process');
const { SSH, buildSshInvocation, classifySshFailure } = require('./ssh-options');

function createBridgeSsh({ ssh = SSH, spawnProcess = spawn, route, log = () => {} } = {}) {
  return (config = {}) => {
    const targetHost = config.host || '';
    const port = config.port || 22;
    const jump = config.jump;
    const choice = route ? route.routeForAttempt() : { route: 'direct', generation: 0 };
    const invocation = buildSshInvocation({
      cfg: { knownHosts: config.knownHosts, jump },
      key: config.key,
      certificate: config.certificate,
      port,
      target: config.user + '@' + targetHost,
      targetHost,
      route: choice.route,
      extraArgs: ['--'],
      // The read-only home mount asks the gateway for its socket with one fixed word (see ssh-gateway.js).
      ...(config.command === 'agentdesk-mount' && { afterTarget: ['agentdesk-mount'] }),
      jump,
      connectTimeout: 10,
    });
    let child;
    try {
      child = spawnProcess(ssh, invocation.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...invocation.env },
      });
    } catch (error) {
      route?.noteFailure(choice.route, { kind: 'config' });
      throw error;
    }

    let stderr = '';
    let settled = false;
    const success = () => {
      if (settled) return;
      settled = true;
      route?.noteSuccess(choice.route);
    };
    const failure = (code, signal, extra = '') => {
      if (settled) return;
      settled = true;
      if (!route) return;
      route.noteFailure(choice.route, classifySshFailure({
        stderr: stderr + extra, code, signal, route: choice.route,
      }));
    };

    child.stdout?.once('data', success);
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      const value = String(chunk);
      stderr = (stderr + value).slice(-8192);
      log('bridge SSH:', value.trim().slice(0, 500));
    });
    child.once('error', (error) => failure(null, null, '\n' + error.message));
    child.once('close', (code, signal) => failure(code, signal));
    return child;
  };
}

module.exports = { createBridgeSsh };