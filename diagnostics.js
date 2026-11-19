const fs = require('node:fs/promises');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { gzip } = require('node:zlib');
const { promisify } = require('node:util');
const { safeFields } = require('./logger');

const compress = promisify(gzip);
const providers = new Set(['codex', 'claude', 'grok', 'gemini', 'antigravity']);
const remoteStates = new Set(['unknown', 'idle', 'ready', 'connecting', 'retry', 'external', 'sleeping', 'error', 'failed']);
const checkStates = new Set(['available', 'unavailable', 'not_configured', 'ready', 'auth_required', 'quota_limited']);

function safeVersion(value) {
  return typeof value === 'string' ? value.match(/\b\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+][a-z0-9.-]{1,20})?\b/i)?.[0] : undefined;
}

function cleanQuota(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => providers.has(entry?.provider)).map(({ provider, state, used }) => ({
    provider, state: checkStates.has(state) ? state : 'unavailable',
    ...(Number.isFinite(used) && used >= 0 && used <= 100 && { used }),
  }));
}

function nonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function cleanResources(input) {
  if (!input || typeof input !== 'object') return undefined;
  const { host, docker, disk } = input;
  return {
    ...(host && { host: { memoryTotalBytes: nonnegative(host.memoryTotalBytes), memoryUsedBytes: nonnegative(host.memoryUsedBytes),
      swapTotalBytes: nonnegative(host.swapTotalBytes), swapUsedBytes: nonnegative(host.swapUsedBytes) } }),
    ...(docker && { docker: { enabled: docker.enabled === true, ok: docker.ok === true,
      count: nonnegative(docker.count), memoryBytes: nonnegative(docker.memoryBytes) } }),
    ...(disk && { disk: { freeRatio: nonnegative(disk.freeRatio) } }),
  };
}

async function collectDiagnostics({ version, config, remote, logger, request = async () => ({ ok: false }) }) {
  const calls = await Promise.allSettled(['routes', 'diagnostics', 'quota_status', 'resource_status']
    .map((operation) => request(operation)));
  const values = calls.map((answer) => answer.status === 'fulfilled' && answer.value?.ok ? answer.value.value : undefined);
  const [route, daemon, quotas, resources] = values;
  const cli = Array.isArray(daemon?.clis) ? daemon.clis.filter((entry) => providers.has(entry?.provider))
    .map(({ provider, state, version: cliVersion }) => ({
      provider, state: checkStates.has(state) ? state : 'unavailable', version: safeVersion(cliVersion),
    })) : [];
  const images = Array.isArray(daemon?.imageDigests) ? daemon.imageDigests.filter((digest) => /^sha256:[a-f0-9]{64}$/.test(digest)) : [];
  const tails = await logger.tails();
  return {
    report: {
      generatedAt: new Date().toISOString(),
      versions: { agentdesk: safeVersion(version), electron: safeVersion(process.versions.electron), node: safeVersion(process.versions.node) },
      system: { platform: process.platform, architecture: process.arch, release: safeVersion(os.release()) },
      config: {
        version: nonnegative(config.version),
        onboardingComplete: config.onboardingComplete === true,
        activeProject: safeFields({ projectId: config.activeProject }).projectId,
        update: { enabled: config.update?.enabled === true, feedConfigured: Boolean(config.update?.feedUrl) },
        projects: (config.projects || []).map(({ id, kind, localRoot, remoteCwd, orchestratorWorkspace }) => ({
          id: safeFields({ projectId: id }).projectId, kind: kind === 'local' ? 'local' : 'remote',
          localConfigured: Boolean(localRoot), remoteConfigured: Boolean(remoteCwd), bridgeConfigured: Boolean(orchestratorWorkspace),
        })),
      },
      remote: {
        ...Object.fromEntries(['sshd', 'tunnel', 'codex'].map((key) => [key, remoteStates.has(remote[key]) ? remote[key] : 'unknown'])),
        route: remote.route?.suspended ? 'suspended'
          : ['direct', 'jump'].includes(remote.route?.route) ? remote.route.route : 'unknown',
      },
      orchestrator: { ssh: route?.ssh === true, relay: route?.relay === true, cli, quotas: cleanQuota(quotas),
        resources: cleanResources(resources ?? daemon?.resources), imageDigests: images },
    },
    ...tails,
  };
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  const field = (value, at, length) => header.write(value, at, length, 'ascii');
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
  field(name, 0, 100);
  field(octal(0o600, 8), 100, 8);
  field(octal(0, 8), 108, 8);
  field(octal(0, 8), 116, 8);
  field(octal(size, 12), 124, 12);
  field(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  field('        ', 148, 8);
  field('0', 156, 1);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  const sum = header.reduce((total, byte) => total + byte, 0);
  field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

async function exportDiagnostics(filename, { report, log, audit }) {
  const jsonl = (rows) => rows.map((row) => JSON.stringify(row) + '\n').join('');
  const files = {
    'diagnostics.json': JSON.stringify(report, null, 2) + '\n',
    'agentdesk.log': jsonl(log),
    'audit.jsonl': jsonl(audit),
  };
  const chunks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    chunks.push(tarHeader(name, data.length), data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, await compress(Buffer.concat(chunks)), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return filename;
}

module.exports = { collectDiagnostics, exportDiagnostics, safeVersion };
