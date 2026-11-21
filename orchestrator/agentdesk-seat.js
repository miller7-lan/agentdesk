#!/usr/bin/env node
// Narrow native-seat launcher (D5, spec §12). Planned replacement for starting native seats through the root
// `codex app-server` key's command/exec, which can run anything as root. This entry point can do one thing:
// start native-project-session-host.js for one provider, mode and session key, in a private mount namespace,
// for the approved device whose key the forced command belongs to.
//
//   authorized_keys (written by an administrator by hand after a backup — N1, gate G4):
//     restrict,command="/usr/bin/env AGENTDESK_DEVICE=<id> AGENTDESK_PLATFORM=<p> /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/agentdesk-seat.js" <key>
//   client:  ssh root@vps2 agentdesk-seat <provider> <read|write> <64-hex session key>
//
// stdin/stdout carry the native channel frames exactly as with the current carrier. Anything else the client
// asks for (another program, extra arguments, another device) is refused before anything starts.
// NOT switched on in production: the client still uses the existing carrier until gate G4 is confirmed.
const path = require('node:path');
const { spawn } = require('node:child_process');
const registry = require('./device-registry');
const { NATIVE_PROVIDERS } = require('./native-channel');

const HOST = path.join(__dirname, 'native-project-session-host.js');
const SESSION_KEY = /^[a-f0-9]{64}$/;

// Returns { provider, mode, sessionKey } or throws; `original` is SSH_ORIGINAL_COMMAND.
function parseRequest(original) {
  if (typeof original !== 'string' || original.length > 200 || /[^\x20-\x7e]/.test(original)) throw new Error('seat_request_invalid');
  const words = original.trim().split(/ +/);
  if (words.length !== 4 || words[0] !== 'agentdesk-seat') throw new Error('seat_request_invalid');
  const [, provider, mode, sessionKey] = words;
  if (!NATIVE_PROVIDERS.includes(provider)) throw new Error('seat_provider_invalid');
  if (!['read', 'write'].includes(mode)) throw new Error('seat_mode_invalid');
  if (!SESSION_KEY.test(sessionKey)) throw new Error('seat_session_key_invalid');
  return { provider, mode, sessionKey };
}

// The command line and a minimal environment for the host. The identity comes from the forced command only.
function launchPlan(env = process.env, { node = process.execPath } = {}) {
  const identity = registry.identityFromEnv(env);
  if (identity.legacy) throw new Error('seat_device_identity_missing');
  if (identity.error) throw new Error(identity.error);
  const request = parseRequest(env.SSH_ORIGINAL_COMMAND);
  return {
    ...request,
    deviceId: identity.deviceId,
    command: '/usr/bin/unshare',
    args: ['--mount', '--propagation', 'private', node, HOST, request.provider, request.mode, request.sessionKey],
    env: {
      PATH: '/opt/agentdesk-orchestrator:/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      AGENTDESK_DEVICE: identity.deviceId,
      AGENTDESK_PLATFORM: identity.platform,
      AGENTDESK_SEAT_LIMITS: 'on',
      ...(env.AGENTDESK_DEVICES && { AGENTDESK_DEVICES: env.AGENTDESK_DEVICES }),
    },
  };
}

function main() {
  let plan;
  try {
    plan = launchPlan(process.env);
    if (process.env.AGENTDESK_SEAT_DRY_RUN === '1') {
      process.stdout.write(JSON.stringify({ command: plan.command, args: plan.args, env: plan.env }) + '\n');
      return;
    }
    if (process.getuid?.() !== 0) throw new Error('seat_launcher_requires_root');
  } catch (error) {
    process.stderr.write('agentdesk-seat: ' + error.message + '\n');
    process.exitCode = 2;
    return;
  }
  const child = spawn(plan.command, plan.args, { env: plan.env, cwd: '/var/tmp', stdio: 'inherit' });
  child.on('error', (error) => { process.stderr.write('agentdesk-seat: ' + error.message + '\n'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
  for (const name of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(name, () => child.kill(name));
}

if (require.main === module) main();

module.exports = { parseRequest, launchPlan };
