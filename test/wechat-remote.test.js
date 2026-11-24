const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RemoteTools } = require('../orchestrator/wechat/remote');
const { toolsFor } = require('../orchestrator/mcp');

test('remote scope: file CRUD, shell, desktop and the three remote tools; other scopes unchanged', () => {
  const names = toolsFor('remote').map((tool) => tool.name);
  for (const name of ['windows_list_directory', 'windows_read_file_chunk', 'windows_write_file', 'windows_delete_path', 'windows_move_path',
    'windows_make_directory', 'local_shell_run', 'local_desktop', 'remote_save_screenshot', 'remote_fetch_file', 'remote_push_file']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('local_env_fix') && !names.includes('windows_run_command'));
  for (const scope of [undefined, 'files', 'local', 'local-write', 'desktop', 'commands']) {
    assert.ok(!toolsFor(scope).some((tool) => tool.name.startsWith('remote_')), String(scope));
  }
});

test('remote tools: capability bound to one device and task folder; write becomes write_batch; push/fetch/screenshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-remote-'));
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'r.docx'), 'DOCX');
  const calls = [];
  const devices = {
    bridge: async (device, kind, body) => {
      calls.push([device.id, kind, body]);
      if (body.operation === 'write_batch') return { results: [{ status: 'written', bytes: 4, version: 'v' }] };
      if (body.operation === 'read') return { offset: 0, size: 3, data: Buffer.from('abc').toString('base64') };
      if (body.operation === 'group_shell') return { code: 0, stdout: 'ok', stderr: '', enforcement: {} };
      return { items: [] };
    },
    screenshot: async (_device, out) => { const file = path.join(out, 'shot.png'); fs.writeFileSync(file, 'PNG'); return file; },
  };
  const tools = new RemoteTools({ socket: path.join(dir, 's.sock'), devices });
  const cap = tools.grant({ user: 'me', device: { id: 'mac' }, dir });
  await assert.rejects(tools.handle({ capability: 'nope', operation: 'list' }), /permission_denied/);
  await tools.handle({ capability: cap, operation: 'list', path: '~/Desktop' });
  assert.deepEqual([calls[0][0], calls[0][1], calls[0][2].root, calls[0][2].anyFolder], ['mac', 'file.read', 'computer', true]);
  assert.deepEqual(await tools.handle({ capability: cap, operation: 'write', path: '~/a.txt', content: 'hi' }), { type: 'file', size: 4, version: 'v' });
  assert.deepEqual(calls[1][2].items, [{ path: '~/a.txt', version: null, content: 'hi', encoding: 'utf8' }]);
  assert.equal(calls[1][2].backup, true);
  assert.equal((await tools.handle({ capability: cap, operation: 'shell', script: 'ls' })).stdout, 'ok');
  assert.deepEqual(await tools.handle({ capability: cap, operation: 'push', source: 'out/r.docx', path: '~/Desktop/r.docx' }), { written: '~/Desktop/r.docx', bytes: 4 });
  await assert.rejects(tools.handle({ capability: cap, operation: 'push', source: '../../etc/passwd', path: '~/x' }), /path_outside_task/);
  assert.deepEqual(await tools.handle({ capability: cap, operation: 'fetch', path: '/Users/x/报告.pdf' }), { saved: 'out/报告.pdf', size: 3 });
  assert.deepEqual(await tools.handle({ capability: cap, operation: 'screenshot_save', filename: '屏幕' }), { saved: 'out/屏幕.png', size: 3 });
  tools.revoke(cap);
  await assert.rejects(tools.handle({ capability: cap, operation: 'list' }), /permission_denied/);
});
