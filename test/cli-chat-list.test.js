const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('the CLI chat list is saved as a union: a chat leaves it only when deleted', () => {
  const cli = read('src/native-cli.js');
  assert.match(cli, /const list = \[\.\.\.shownChats, \.\.\.saved\(\)\.filter\(\(chat\) => !ids\.has\(chat\.id\)\)\]/);
  assert.match(cli, /forgotten\.add\(s\.id\);/);
  assert.match(cli, /function create\(project, agent\) \{\s*restore\(\);/);
  assert.match(cli, /api\.saveChats\?\.\(list\)/);
  assert.match(cli, /Promise\.resolve\(api\.chats\?\.\(\)\)\.then/);
});

test('opening a project puts saved CLI chats back before deciding to start a new one', () => {
  assert.match(read('src/projects.js'), /function openProject\(id\) \{[\s\S]*?AgentDeskNativeCli\?\.restore\?\.\(\);[\s\S]*?const target/);
});

test('the list has a durable copy in userData (cli-chats.json), validated on both ways', () => {
  const main = read('main.js');
  const preload = read('preload.js');
  assert.match(main, /ipcMain\.handle\('tui:chats', \(event\) => \{\s*if \(!fromMainWindow\(event\)\) return \[\];/);
  assert.match(main, /ipcMain\.handle\('tui:chats-save', \(event, list\) => \{\s*if \(!fromMainWindow\(event\)\) return false;/);
  assert.match(main, /validCliChats\(list\)/);
  assert.match(preload, /chats: \(\) => ipcRenderer\.invoke\('tui:chats'\)/);
  const start = main.indexOf('function validCliChats');
  const body = main.slice(start, main.indexOf('\n}\n', start) + 2);
  const validCliChats = new Function(body + '\nreturn validCliChats;')();
  const good = { id: 'C' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), project: 'group-x', agent: 'claude', title: 'Claude Code', created: 1, extra: 1 };
  assert.deepEqual(validCliChats([good, { ...good, id: 'x' }, { ...good, agent: 'sh' }, null]), [{ id: good.id, project: 'group-x', agent: 'claude', title: 'Claude Code', created: 1 }]);
  assert.deepEqual(validCliChats('no'), []);
});
