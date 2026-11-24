const { createInterface } = require('node:readline');
const { connect } = require('node:net');
const { appendFileSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { Lines } = require('./transport');
const { spec: batchSpec, validate: validateFileBatch, editSpec } = require('./file-batch');

const { searchSpec } = require('./file-search');

const operations = {
  windows_list_locations: ['locations', []],
  windows_list_directory: ['list', ['path']],
  windows_stat_file: ['stat', ['path']],
  windows_search_files: ['search', ['path', 'query']],
  windows_grep_files: ['grep', ['path', 'query']],
  windows_read_file_chunk: ['read', ['path']],
  windows_write_file: ['write', ['path', 'content']],
  windows_make_directory: ['mkdir', ['path']],
  windows_move_path: ['move', ['path', 'destination']],
  windows_delete_path: ['delete', ['path']],
  windows_list_commands: ['commands', []],
  windows_run_command: ['run', ['command']],
  windows_glob_files: ['glob'],
  windows_grep_context: ['grep_context'],
  windows_edit_file: ['edit'],
  windows_read_files_batch: ['read_batch', ['items']],
  windows_write_files_batch: ['write_batch', ['items']],
  local_desktop: ['desktop', ['tool', 'arguments']],
  // group chat v7 (localStages / localCopy / envFix): exposed only in the scopes below
  local_shell_run: ['shell', ['script']],
  local_env_fix: ['env_fix', ['patch', 'reason']],
  // 微信管理员远程电脑（scope remote）：截屏存成文件发给用户、把电脑上的文件拿回来、把任务里的文件放到电脑上
  remote_save_screenshot: ['screenshot_save', ['filename']],
  remote_fetch_file: ['fetch', ['path']],
  remote_push_file: ['push', ['source', 'path']],
};
const REMOTE_ONLY = new Set(['screenshot_save', 'fetch', 'push']);

const descriptions = {
  locations: 'List the local locations this computer authorized, including the project and any additional read-only folders. The computer location (when enabled) covers the person\'s home, mounted volumes and temporary folders: every step can read it, and steps that change files can also write there when the computer allows it. Use the returned id as root in file tools.',
  list: 'List a directory in an authorized local location on the person\'s machine.',
  stat: 'Get a file\'s size and SHA-256 version in an authorized local location on the person\'s machine.',
  search: 'Search file and folder names in an authorized local location on the person\'s machine.',
  grep: 'Search file contents in an authorized local location on the person\'s machine, including files not in Git such as local config and logs. Returns path, line and text for each match.',
  read: 'Read one file chunk as Base64 from an authorized local location on the person\'s machine. Pass version and offset to continue reading.',
  write: 'Create or overwrite a file in any folder of the person\'s computer (root "computer", absolute path or ~/...). Only steps that change files may use it; project files are changed in the task workspace instead. Pass version from windows_stat_file to overwrite an existing file; omit it for a new file.',
  mkdir: 'Create a folder anywhere on the person\'s computer (root "computer"); its parent must exist.',
  move: 'Move or rename a file or folder on the person\'s computer (root "computer"); destination is an absolute path.',
  delete: 'Move a file or folder on the person\'s computer (root "computer") to the trash.',
  commands: 'List the commands the person allows agents to run in their project.',
  run: 'Run one allowed command in the person\'s real project, as it is now (your changes are not applied there). Use it to reproduce problems or inspect the local environment. Returns exit code, stdout and stderr.',
  shell: 'Run any command on the person\'s computer (zsh/bash on a Mac, PowerShell/cmd on Windows). Reading, review, diagnosis and acceptance steps run it in the person\'s real project as it is now; a step that changes code runs it in its local copy of the project, which holds your current changes (changes the command makes there come back to your working tree). On a Mac credential folders and AgentDesk\'s own folders are closed to it (and, in the copy, the original project); on Windows nothing is closed: say so if it matters. Returns exit code, stdout and stderr.',
  env_fix: 'Apply an environment fix to the person\'s real project: a unified diff (git format, paths relative to the project root) that makes the project run on this computer (toolchain, dependencies, paths, line endings, platform-specific code). Use it only for environment problems, not for the task\'s own logic. Credential folders, .git and AgentDesk\'s folders are refused. The previous content is kept so the person can undo it; the fix is also carried into the cloud working trees. Afterwards run the check again.',
  screenshot_save: 'Take a screenshot of the remote computer and save it as out/<filename>.png in the task folder, so it is sent to the person in WeChat. Use local_desktop with desktop_screenshot when you only need to look.',
  fetch: 'Copy a file from the remote computer (absolute path or ~/...) into out/ of the task folder, so it is sent to the person in WeChat.',
  push: 'Copy a file from the task folder (source, relative path such as out/report.docx) to the remote computer (path, absolute or ~/...). Fails if the target exists unless overwrite is true.',
  desktop: 'Operate the authorized local desktop. Start with desktop_screenshot or desktop_snapshot. Use the desktop tool name and its arguments, for example desktop_screenshot with {}.',
};

const remoteSchemas = {
  screenshot_save: { filename: { type: 'string', description: 'File name without folder, e.g. screen.png' } },
  fetch: { path: { type: 'string', description: 'Absolute path or ~/... on the remote computer' } },
  push: { source: { type: 'string', description: 'Path relative to the task folder, e.g. out/report.docx' },
    path: { type: 'string', description: 'Absolute target path or ~/... on the remote computer' }, overwrite: { type: 'boolean' } },
};

const tools = Object.entries(operations).map(([name, [action, required]]) => {
  if (REMOTE_ONLY.has(action)) {
    return { name, description: descriptions[action], annotations: { readOnlyHint: action === 'screenshot_save' },
      inputSchema: { type: 'object', properties: remoteSchemas[action], required, additionalProperties: false } };
  }
  if (['read_batch', 'write_batch', 'glob', 'grep_context', 'edit'].includes(action)) {
    const write = action === 'write_batch' || action === 'edit';
    const tool = action === 'edit' ? editSpec(name) : action.endsWith('_batch')
      ? batchSpec(name, write) : searchSpec(name, action === 'grep_context');
    delete tool.type;
    tool.annotations = { readOnlyHint: !write };
    tool.inputSchema.properties.root = {
      type: 'string', description: write ? 'Use computer with absolute paths outside the project.' : 'Location id; project is the default.',
      ...(write && { enum: ['computer'] }),
    };
    if (write) tool.inputSchema.required.push('root');
    if (action === 'glob' || action === 'grep_context') {
      tool.inputSchema.properties.path.description = 'Directory relative to the selected root. Use an empty string for the root or an absolute path with root computer.';
    }
    return tool;
  }
  return {
  name,
  description: descriptions[action],
  annotations: { readOnlyHint: !['run', 'write', 'mkdir', 'move', 'delete', 'desktop', 'shell', 'env_fix'].includes(action) },
  inputSchema: {
    type: 'object',
    properties: {
      ...(required.includes('path') ? { path: { type: 'string', description: 'Slash-separated path relative to the selected root. Empty string means the root. For the computer root, use an absolute path (or ~ for the home folder), for example /Users/name/Documents or C:/Users/name/Documents.' } } : {}),
      ...(required.includes('path') ? { root: { type: 'string', description: 'A location id returned by windows_list_locations. Defaults to project. Additional locations are read-only; computer can be read by every step and changed by steps whose task allows file changes.' } } : {}),
      ...(required.includes('query') ? { query: { type: 'string' } } : {}),
      ...(action === 'grep' ? { caseSensitive: { type: 'boolean' } } : {}),
      ...(action === 'read' ? { offset: { type: 'integer', minimum: 0 }, version: { type: 'string' } } : {}),
      ...(action === 'run' ? { command: { type: 'string', description: 'A name returned by windows_list_commands.' } } : {}),
      ...(action === 'desktop' ? { tool: { type: 'string', pattern: '^desktop_[a-z_]+$' },
        arguments: { type: 'object' } } : {}),
      ...(action === 'write' ? { content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, version: { type: 'string', description: 'Current version from windows_stat_file; omit for a new file.' } } : {}),
      ...(action === 'move' ? { destination: { type: 'string', description: 'Absolute path of the new location.' } } : {}),
      ...(action === 'shell' ? { script: { type: 'string', description: 'The command line to run.' },
        shell: { type: 'string', enum: ['zsh', 'bash', 'powershell', 'cmd'] }, cwd: { type: 'string', description: 'Folder relative to the project (or copy) root.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 900000 } } : {}),
      ...(action === 'env_fix' ? { patch: { type: 'string', description: 'Unified diff, paths relative to the project root.' },
        reason: { type: 'string', description: 'Why this is an environment problem on this computer.' },
        platformSource: { type: 'boolean', description: 'True when the fix changes platform-specific source code (R3).' } } : {}),
    },
    required,
    additionalProperties: false,
  },
  };
});

// Scopes: files, commands, desktop (as before); local — a reading/review/acceptance step in the live project
// (files, commands, any command, environment fixes); local-write — a code-changing step (files outside the
// project, commands, any command in its local copy).
function toolsFor(scope) {
  return tools.filter(({ name }) => {
    const [operation] = operations[name];
    // remote：微信管理员操作关联电脑——文件增删改查（整机）、任意命令、桌面、截屏/取文件/放文件；没有项目命令表和环境修复。
    if (scope === 'remote') return !['commands', 'run', 'env_fix'].includes(operation);
    if (REMOTE_ONLY.has(operation)) return false;
    if (operation === 'desktop') return scope === 'desktop';
    if (operation === 'env_fix') return scope === 'local';
    if (operation === 'shell') return scope === 'local' || scope === 'local-write';
    if (!scope || scope === 'local' || scope === 'local-write') return true;
    if (scope === 'commands') return operation === 'commands' || operation === 'run';
    return scope === 'files' && operation !== 'commands' && operation !== 'run';
  });
}

// Mutations leave a local, verifiable record next to the step log. A step may claim success only when the
// matching receipt shows the bridge accepted the write and returned the new version.
const MUTATIONS = new Set(['write', 'edit', 'mkdir', 'move', 'delete']);

function receiptFor(operation, args, requestId, value, error) {
  const text = (field) => typeof field === 'string' ? field : undefined;
  return {
    id: randomUUID(),
    requestId,
    operation: operation === 'edit' ? 'write' : operation,
    at: new Date().toISOString(),
    root: text(args.root),
    path: text(args.path),
    destination: text(args.destination),
    expectedVersion: text(args.version),
    encoding: text(args.encoding),
    ok: !error,
    ...(value && typeof value === 'object' ? { type: value.type, version: value.version, size: value.size } : {}),
    ...(error ? { error: String(error.message || error).slice(0, 300) } : {}),
  };
}

function writeReceipt(filename, receipt) {
  if (!filename) return;
  try { appendFileSync(filename, JSON.stringify(receipt) + '\n', { mode: 0o600 }); } catch {}
}

function request(socketPath, frame, timeout = 35000, limit) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const wire = new Lines(socket, socket, limit);
    const timer = setTimeout(() => {
      reject(new Error('mcp_request_timeout'));
      socket.destroy();
    }, timeout);
    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error('mcp_socket_closed'));
    });
    wire.on('fault', reject);
    wire.once('frame', (message) => {
      if (message.ok) resolve(message.value);
      else reject(Object.assign(new Error(message.error), { requestId: message.request_id }));
      socket.destroy();
    });
    socket.once('connect', () => wire.send(frame));
  });
}

if (require.main === module) {
  // 第三个参数是 scope（Codex 不把自定义环境变量传给 MCP 服务，所以 remote 放在参数里）。
  const [socketPath = process.env.AGENTDESK_MCP_SOCKET, capability = process.env.AGENTDESK_MCP_CAPABILITY, scopeArg] = process.argv.slice(2);
  if (!socketPath || !capability) process.exit(1);
  const exposed = toolsFor(scopeArg || process.env.AGENTDESK_MCP_SCOPE);
  const names = new Set(exposed.map(({ name }) => name));
  const input = createInterface({ input: process.stdin });
  input.on('line', async (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id === undefined) return;
    let result;
    try {
      if (frame.method === 'initialize') {
        result = { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'agentdesk-windows', version: '1.0.0' } };
      } else if (frame.method === 'ping') {
        result = {};
      } else if (frame.method === 'tools/list') {
        result = { tools: exposed };
      } else if (frame.method === 'tools/call' && names.has(frame.params.name)) {
        const [operation] = operations[frame.params.name];
        const args = frame.params.arguments || {};
        const batch = operation === 'read_batch' || operation === 'write_batch';
        if (batch) validateFileBatch(args.items, operation === 'write_batch');
        if (operation === 'desktop') {
          const reply = await request(socketPath, { capability, operation, tool: args.tool, arguments: args.arguments }, 55000);
          const content = [];
          for (const item of reply.contentItems) {
            if (item.type === 'text') {
              content.push(item);
            } else {
              const chunks = [];
              for (let offset = 0; offset < item.size;) {
                const chunk = await request(socketPath, { capability, operation: 'desktop_image', stream_id: item.stream_id, offset });
                const bytes = Buffer.from(chunk.data, 'base64');
                if (!bytes.length || chunk.offset !== offset || offset + bytes.length > item.size) throw new Error('invalid_desktop_image');
                chunks.push(bytes);
                offset += bytes.length;
              }
              const bytes = Buffer.concat(chunks);
              if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('invalid_desktop_image');
              content.push({ type: 'image', mimeType: item.mimeType, data: bytes.toString('base64') });
            }
          }
          result = { isError: !reply.success, content };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
          return;
        }
        // Forward every argument the service acts on. Dropping content here made every write look empty
        // ("invalid_content") even though the client had listed the write tools.
        try {
          const value = await request(socketPath, { capability, operation, root: args.root, path: args.path, query: args.query, offset: args.offset,
            version: args.version, caseSensitive: args.caseSensitive, command: args.command,
            content: args.content, encoding: args.encoding, destination: args.destination,
            ...(operation === 'edit' && { oldText: args.oldText, newText: args.newText, replaceAll: args.replaceAll }),
            ...(['glob', 'grep_context'].includes(operation) && { glob: args.glob, context: args.context }),
            ...(batch && { items: args.items }),
            ...(REMOTE_ONLY.has(operation) && { filename: args.filename, source: args.source, overwrite: args.overwrite === true }),
            ...(operation === 'shell' && { script: args.script, shell: args.shell, cwd: args.cwd, timeout_ms: args.timeout_ms }),
            ...(operation === 'env_fix' && { patch: args.patch, reason: args.reason, platformSource: args.platformSource === true }) },
          operation === 'run' ? 320000 : operation === 'shell' ? Math.min(1600000, (Number.isSafeInteger(args.timeout_ms) ? args.timeout_ms : 300000) + 660000)
            : operation === 'env_fix' ? 200000 : 35000);
          if (MUTATIONS.has(operation)) writeReceipt(process.env.AGENTDESK_MCP_RECEIPTS, receiptFor(operation, args, frame.id, value));
          const failedBatch = operation === 'write_batch' && value.results.some(({ status }) => status !== 'written');
          if (operation === 'write_batch') value.results.forEach((item, index) => {
            if (item.status === 'not_run') return;
            const error = item.status === 'written' ? null : new Error(item.error);
            writeReceipt(process.env.AGENTDESK_MCP_RECEIPTS,
              receiptFor('write', { ...args.items[index], root: args.root }, frame.id, item, error));
          });
          result = { ...(failedBatch && { isError: true }), content: [{ type: 'text', text: JSON.stringify(value) }] };
        } catch (error) {
          if (MUTATIONS.has(operation)) writeReceipt(process.env.AGENTDESK_MCP_RECEIPTS, receiptFor(operation, args, frame.id, null, error));
          if (operation === 'write_batch') for (const item of args.items) {
            writeReceipt(process.env.AGENTDESK_MCP_RECEIPTS,
              receiptFor('write', { ...item, root: args.root }, frame.id, null, error));
          }
          throw error;
        }
      } else {
        throw new Error('unsupported_mcp_method');
      }
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: error.message }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
  });
}

module.exports = { request, toolNames: Object.keys(operations), toolsFor, receiptFor, writeReceipt, MUTATIONS };
