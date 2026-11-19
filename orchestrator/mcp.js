const { createInterface } = require('node:readline');
const { connect } = require('node:net');
const { Lines } = require('./transport');

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
};

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
};

const tools = Object.entries(operations).map(([name, [action, required]]) => ({
  name,
  description: descriptions[action],
  annotations: { readOnlyHint: !['run', 'write', 'mkdir', 'move', 'delete'].includes(action) },
  inputSchema: {
    type: 'object',
    properties: {
      ...(required.includes('path') ? { path: { type: 'string', description: 'Slash-separated path relative to the selected root. Empty string means the root. For the computer root, use an absolute path (or ~ for the home folder), for example /Users/name/Documents or C:/Users/name/Documents.' } } : {}),
      ...(required.includes('path') ? { root: { type: 'string', description: 'A location id returned by windows_list_locations. Defaults to project. Additional locations are read-only; computer can be read by every step and changed by steps whose task allows file changes.' } } : {}),
      ...(required.includes('query') ? { query: { type: 'string' } } : {}),
      ...(action === 'grep' ? { caseSensitive: { type: 'boolean' } } : {}),
      ...(action === 'read' ? { offset: { type: 'integer', minimum: 0 }, version: { type: 'string' } } : {}),
      ...(action === 'run' ? { command: { type: 'string', description: 'A name returned by windows_list_commands.' } } : {}),
      ...(action === 'write' ? { content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, version: { type: 'string', description: 'Current version from windows_stat_file; omit for a new file.' } } : {}),
      ...(action === 'move' ? { destination: { type: 'string', description: 'Absolute path of the new location.' } } : {}),
    },
    required,
    additionalProperties: false,
  },
}));

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
  const [socketPath = process.env.AGENTDESK_MCP_SOCKET, capability = process.env.AGENTDESK_MCP_CAPABILITY] = process.argv.slice(2);
  if (!socketPath || !capability) process.exit(1);
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
        result = { tools };
      } else if (frame.method === 'tools/call' && Object.hasOwn(operations, frame.params.name)) {
        const [operation] = operations[frame.params.name];
        const args = frame.params.arguments || {};
        // Forward every argument the service acts on. Dropping content here made every write look empty
        // ("invalid_content") even though the client had listed the write tools.
        const value = await request(socketPath, { capability, operation, root: args.root, path: args.path, query: args.query, offset: args.offset,
          version: args.version, caseSensitive: args.caseSensitive, command: args.command,
          content: args.content, encoding: args.encoding, destination: args.destination }, operation === 'run' ? 320000 : 35000);
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else {
        throw new Error('unsupported_mcp_method');
      }
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: error.message }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
  });
}

module.exports = { request, toolNames: Object.keys(operations) };
