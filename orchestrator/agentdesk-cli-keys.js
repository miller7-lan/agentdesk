#!/usr/bin/env node
// Administrator tool (root): opens or closes native CLI single chats for one device by adding / removing its "cli"
// key in the agentdesk account's authorized keys. The key may open a terminal (pty) and run one thing only:
// agentdesk-cli.js, as agentdesk, with the device identity fixed here (the client cannot choose it).
//
//   node agentdesk-cli-keys.js add <deviceId> <win32|darwin> '<ssh-ed25519 AAAA… comment>'
//   node agentdesk-cli-keys.js remove <deviceId>
//   node agentdesk-cli-keys.js list
const fs = require('node:fs');

const FILE = process.env.AGENTDESK_CLI_KEYS_FILE || '/etc/ssh/agentdesk-authorized-keys';
const INSTALL = '/opt/agentdesk-orchestrator';
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const tag = (device) => `agentdesk-${device}-cli`;

function line(device, platform, publicKey) {
  if (!DEVICE.test(device || '')) throw new Error('invalid_device');
  if (!['win32', 'darwin'].includes(platform)) throw new Error('invalid_platform');
  const [type, blob] = String(publicKey || '').trim().split(/\s+/);
  if (type !== 'ssh-ed25519' || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob || '')) throw new Error('invalid_public_key');
  return `restrict,pty,command="/usr/bin/env AGENTDESK_DEVICE=${device} AGENTDESK_PLATFORM=${platform} ${INSTALL}/node ${INSTALL}/agentdesk-cli.js" ${type} ${blob} ${tag(device)}`;
}

function rewrite(change) {
  const before = fs.readFileSync(FILE, 'utf8');
  const after = change(before.split('\n').filter((item, index, all) => item || index < all.length - 1)).join('\n') + '\n';
  if (after === before) return false;
  fs.copyFileSync(FILE, `${FILE}.bak-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`);
  const temp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(temp, after, { mode: fs.statSync(FILE).mode & 0o777 });
  fs.renameSync(temp, FILE);
  return true;
}

function main([op, device, platform, ...key]) {
  if (op === 'list') {
    for (const item of fs.readFileSync(FILE, 'utf8').split('\n')) if (/ agentdesk-[\w-]+-cli$/.test(item)) console.log(item.split(' ').pop());
    return;
  }
  if (op === 'add') {
    const entry = line(device, platform, key.join(' '));
    const blob = entry.split(' ').slice(-2, -1)[0];
    const changed = rewrite((lines) => {
      if (lines.some((item) => item.includes(' ' + blob + ' ') && !item.endsWith(' ' + tag(device)))) throw new Error('key_already_used_by_another_entry');
      return [...lines.filter((item) => !item.endsWith(' ' + tag(device))), entry];
    });
    console.log(changed ? `added ${tag(device)}` : 'unchanged');
    return;
  }
  if (op === 'remove') {
    if (!DEVICE.test(device || '')) throw new Error('invalid_device');
    console.log(rewrite((lines) => lines.filter((item) => !item.endsWith(' ' + tag(device)))) ? `removed ${tag(device)}` : 'unchanged');
    return;
  }
  throw new Error('usage: add <device> <win32|darwin> <pubkey> | remove <device> | list');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { line };
