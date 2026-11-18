const test = require('node:test');
const assert = require('node:assert/strict');
const { parseActivity } = require('../orchestrator/activity');

const log = (...events) => events.map((event) => 'stdout ' + (typeof event === 'string' ? event : JSON.stringify(event))).join('\n');

test('codex events become thinking, commands with output, file changes and the reply, updated in place', () => {
  const { items } = parseActivity('codex', log(
    { type: 'thread.started', thread_id: 't1' },
    { type: 'item.completed', item: { id: 'a', type: 'reasoning', text: 'Look at the auth client first.' } },
    { type: 'item.started', item: { id: 'b', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'b', type: 'command_execution', command: 'npm test', aggregated_output: '42 passed', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'c', type: 'file_change', changes: [{ path: 'src/auth/client.js', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'd', type: 'agent_message', text: 'Added a timeout.' } },
    { type: 'turn.completed', usage: { input_tokens: 1 } },
  ) + '\nstderr some warning');
  assert.deepEqual(items.map((item) => item.kind), ['thinking', 'command', 'edit', 'message']);
  assert.equal(items[1].output, '42 passed');
  assert.equal(items[1].exitCode, 0);
  assert.equal(items[2].files[0].path, 'src/auth/client.js');
});

test('claude tool calls are paired with their results; Bash is a command and Edit a file change', () => {
  const { items } = parseActivity('claude', log(
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Plan the change.' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls src' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'auth\nui' }] }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u2', name: 'Edit', input: { file_path: 'src/a.js' } }, { type: 'text', text: 'Done.' }] } },
    { type: 'result', result: 'Done.', is_error: false },
  ));
  assert.deepEqual(items.map((item) => item.kind), ['thinking', 'command', 'edit', 'message']);
  assert.equal(items[1].command, 'ls src');
  assert.equal(items[1].output, 'auth\nui');
  assert.equal(items[1].status, 'completed');
});

test('gemini deltas join into one reply; unknown CLIs and plain text still show their words', () => {
  const gemini = parseActivity('gemini', log(
    { type: 'tool_use', tool_id: 't', tool_name: 'run_shell_command', parameters: { command: 'git status' } },
    { type: 'tool_result', tool_id: 't', status: 'success', output: 'clean' },
    { type: 'message', role: 'assistant', content: 'Hel', delta: true },
    { type: 'message', role: 'assistant', content: 'lo', delta: true },
  )).items;
  assert.deepEqual(gemini.map((item) => item.kind), ['command', 'message']);
  assert.equal(gemini[1].text, 'Hello');
  const generic = parseActivity('antigravity', log({ type: 'thought', text: 'Checking.' }, { type: 'result', result: { response: 'All good.' } })).items;
  assert.deepEqual(generic.map((item) => [item.kind, item.text]), [['thinking', 'Checking.'], ['message', 'All good.']]);
  const plain = parseActivity('grok', log('Reading files…', 'Found the bug.')).items;
  assert.deepEqual(plain.map((item) => item.kind), ['message']);
  assert.match(plain[0].text, /Found the bug/);
});
