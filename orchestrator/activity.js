// Turns a step's CLI log into the member's working record: what it thought, which commands it ran and what
// they printed, which files it changed, which tools and searches it used, and what it said.
// The log holds one line per CLI output line, prefixed "stdout " or "stderr "; secrets are already redacted.
// Every CLI reports this differently, so each has a small reader; unknown JSON falls back to any text it carries.
const { constants } = require('node:fs');
const { open } = require('node:fs/promises');
const path = require('node:path');

const MAX_READ = 1536 * 1024;
const MAX_ITEMS = 300;
const MAX_TEXT = 4000;
const MAX_OUTPUT = 3000;

const clip = (value, limit = MAX_TEXT) => {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit) + '…' : text;
};
const tailClip = (value, limit = MAX_OUTPUT) => {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  return text.length > limit ? '…' + text.slice(-limit) : text;
};
const brief = (input) => {
  if (!input || typeof input !== 'object') return clip(input, 300);
  const pick = input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.absolute_path ?? input.pattern ?? input.query ?? input.url;
  return clip(typeof pick === 'string' ? pick : JSON.stringify(input), 300);
};
const textOf = (content) => Array.isArray(content)
  ? content.map((part) => typeof part === 'string' ? part : part?.text ?? '').join('')
  : typeof content === 'string' ? content : content === undefined ? '' : JSON.stringify(content);

// Names CLIs use for tools that run a shell command or change a file.
const SHELL = /^(bash|shell|run_shell_command|exec(_command)?|terminal)$/i;
const EDIT = /^(edit|write|multiedit|notebookedit|write_file|replace|edit_file|apply_patch|str_replace\w*)$/i;

class Record {
  constructor() {
    this.items = [];
    this.byId = new Map();
    this.dropped = 0;
  }

  add(item, id) {
    if (id !== undefined && this.byId.has(id)) return Object.assign(this.byId.get(id), item);
    // Keep the newest work visible: evict the oldest entry instead of refusing new ones. Dropping new
    // events made a long step look frozen at its first 300 items even while it was still progressing.
    if (this.items.length >= MAX_ITEMS) {
      const oldest = this.items.shift();
      if (oldest) {
        for (const [key, value] of this.byId) {
          if (value === oldest) { this.byId.delete(key); break; }
        }
      }
      this.dropped += 1;
    }
    this.items.push(item);
    if (id !== undefined) this.byId.set(id, item);
    return item;
  }

  // A tool call, filed as a command, a file change or a generic tool depending on what it does.
  tool(id, name, input) {
    if (SHELL.test(name)) return this.add({ kind: 'command', command: brief(input), status: 'running' }, id);
    if (EDIT.test(name)) return this.add({ kind: 'edit', files: [{ path: brief(input), change: name }] }, id);
    if (/search|fetch|grep|glob/i.test(name) && /web|google|fetch/i.test(name)) return this.add({ kind: 'search', text: brief(input) }, id);
    return this.add({ kind: 'tool', name: clip(name, 80), input: brief(input), status: 'running' }, id);
  }

  result(id, output, failed) {
    const item = this.byId.get(id);
    if (!item) return;
    if (item.kind === 'command' || item.kind === 'tool') {
      item.output = tailClip(output);
      item.status = failed ? 'failed' : 'completed';
    } else if (failed) item.error = clip(output, 600);
  }

  message(text, append = false) {
    const last = this.items.at(-1);
    if (append && last?.kind === 'message') last.text = clip(last.text + text);
    else if (text.trim()) this.add({ kind: 'message', text: clip(text) });
  }

  thinking(text, append = false) {
    const last = this.items.at(-1);
    if (append && last?.kind === 'thinking') last.text = clip(last.text + text);
    else if (text.trim()) this.add({ kind: 'thinking', text: clip(text) });
  }
}

const readers = {
  // codex exec --json: item.started / item.updated / item.completed carry one item each, updated in place.
  codex(event, record) {
    if (event.type === 'error' || event.type === 'turn.failed') {
      record.add({ kind: 'error', text: clip(event.message || event.error?.message || 'error', 600) });
      return;
    }
    const item = event.item;
    if (!item || !String(event.type).startsWith('item.')) return;
    const id = 'codex:' + item.id;
    switch (item.type) {
      case 'reasoning': record.add({ kind: 'thinking', text: clip(item.text) }, id); break;
      case 'agent_message': record.add({ kind: 'message', text: clip(item.text) }, id); break;
      case 'command_execution': record.add({ kind: 'command', command: clip(item.command, 600), output: tailClip(item.aggregated_output),
        exitCode: item.exit_code ?? undefined, status: item.status }, id); break;
      case 'file_change': record.add({ kind: 'edit', files: (item.changes || []).slice(0, 40).map((change) =>
        ({ path: clip(change.path, 300), change: change.kind })), status: item.status }, id); break;
      case 'mcp_tool_call': record.add({ kind: 'tool', name: clip([item.server, item.tool].filter(Boolean).join('.'), 80),
        input: brief(item.arguments), output: tailClip(item.result?.content ? textOf(item.result.content) : item.error?.message),
        status: item.status }, id); break;
      case 'web_search': record.add({ kind: 'search', text: clip(item.query, 300) }, id); break;
      case 'todo_list': record.add({ kind: 'plan', steps: (item.items || []).slice(0, 30).map((step) =>
        ({ text: clip(step.text, 200), done: Boolean(step.completed) })) }, id); break;
      case 'error': record.add({ kind: 'error', text: clip(item.message, 600) }, id); break;
      default: break;
    }
  },

  // claude -p --output-format stream-json: assistant messages hold thinking, text and tool_use blocks;
  // the following user message holds the tool_result for each tool_use.
  claude(event, record) {
    const blocks = event.message?.content;
    if (event.type === 'assistant' && Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block.type === 'thinking') record.thinking(block.thinking || '');
        else if (block.type === 'text') record.message(block.text || '');
        else if (block.type === 'tool_use') record.tool('claude:' + block.id, block.name, block.input);
      }
    } else if (event.type === 'user' && Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block.type === 'tool_result') record.result('claude:' + block.tool_use_id, textOf(block.content), block.is_error);
      }
    } else if (event.type === 'result' && event.is_error) {
      record.add({ kind: 'error', text: clip(event.result || event.subtype || 'error', 600) });
    }
  },

  // gemini --output-format stream-json: message (with delta), tool_use / tool_result pairs, error.
  gemini(event, record) {
    if (event.type === 'message' && event.role === 'assistant') record.message(textOf(event.content), event.delta === true);
    else if (event.type === 'thought' || event.type === 'thinking') record.thinking(textOf(event.content ?? event.text ?? event.subject), event.delta === true);
    else if (event.type === 'tool_use') record.tool('gemini:' + event.tool_id, event.tool_name || 'tool', event.parameters);
    else if (event.type === 'tool_result') record.result('gemini:' + event.tool_id, event.output ?? event.error?.message, event.status === 'error');
    else if (event.type === 'error') record.add({ kind: 'error', text: clip(event.message || textOf(event.error), 600) });
  },
};

// CLIs described by configuration (Antigravity) and anything unrecognised: keep whatever text an event carries.
function generic(event, record) {
  const type = String(event.type || event.event || '');
  const text = [event.text, event.content, event.delta, event.message, event.response, event.result?.response]
    .map((value) => typeof value === 'string' ? value : Array.isArray(value) ? textOf(value) : '').find((value) => value.trim());
  if (/error/i.test(type) || event.result?.error) {
    record.add({ kind: 'error', text: clip(text || textOf(event.error ?? event.result?.error), 600) });
  } else if (/thought|thinking|reason/i.test(type)) record.thinking(text || '', /delta/i.test(type) || event.delta === true);
  else if (/tool/i.test(type) && /result|output|response/i.test(type)) {
    record.result('generic:' + (event.tool_id ?? event.id ?? event.call_id), event.output ?? text, event.status === 'error');
  } else if (/tool|call|function/i.test(type) && (event.name || event.tool_name || event.tool)) {
    record.tool('generic:' + (event.tool_id ?? event.id ?? event.call_id), event.name || event.tool_name || event.tool,
      event.input ?? event.parameters ?? event.arguments ?? event.args);
  } else if (text) record.message(text, event.delta === true || /delta|chunk/i.test(type));
}

function parseActivity(provider, log) {
  const record = new Record();
  let plain = '';
  for (const line of log.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const channel = line.slice(0, space);
    const body = line.slice(space + 1);
    if (channel !== 'stdout') continue;   // stderr is CLI chatter; failures reach the person through the step error
    let event;
    try { event = JSON.parse(body); } catch { event = undefined; }
    if (!event || typeof event !== 'object') {
      plain += body + '\n';
      continue;
    }
    if (plain) { record.message(plain); plain = ''; }
    (readers[provider] || generic)(event, record);
  }
  if (plain) record.message(plain);
  return { items: record.items, dropped: record.dropped };
}

async function stepActivity(stateDir, task, stepId) {
  // The lead's planning runs as a step of its own (planner / group-planner) that is not in task.steps.
  const step = (task.steps || []).find((candidate) => candidate.id === stepId) ||
    (['planner', 'group-planner'].includes(stepId) && (task.groupPlan || task.planRaw || task.state === 'planning') ? { id: stepId, role: 'claude', state: task.state === 'planning' ? 'running' : 'completed' } : null);
  if (!step || !/^[a-z0-9_-]{1,32}$/.test(stepId)) throw new Error('invalid_artifact');
  let text = '';
  let truncated = false;
  try {
    const file = await open(path.join(stateDir, 'logs', task.id, stepId + '.log'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const { size } = await file.stat();
      const length = Math.min(size, MAX_READ);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, size - length);
      text = buffer.toString('utf8', 0, bytesRead);
      truncated = size > MAX_READ;
      if (truncated) text = text.slice(text.indexOf('\n') + 1);   // drop the partial first line
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { ...parseActivity(step.role, text), truncated, state: step.state };
}

module.exports = { parseActivity, stepActivity };
