const { createInterface } = require('node:readline');
const { connect } = require('node:net');
const { Lines } = require('./transport');

const operations = {
  windows_list_directory: ['list', []],
  windows_stat_file: ['stat', []],
  windows_search_files: ['search', ['query']],
  windows_read_file_chunk: ['read', []],
};

const tools = Object.entries(operations).map(([name, [action, extra]]) => ({
  name,
  description: {
    list: 'List a directory in the authorized Windows project.',
    stat: 'Get the Windows file size and SHA-256 version.',
    search: 'Search names in the authorized Windows project.',
    read: 'Read one Windows file chunk as Base64. Pass version and offset to continue reading.',
  }[action],
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Slash-separated path relative to the project. Empty string means project root.' },
      ...(action === 'search' ? { query: { type: 'string' } } : {}),
      ...(action === 'read' ? { offset: { type: 'integer', minimum: 0 }, version: { type: 'string' } } : {}),
    },
    required: ['path', ...extra],
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
  const [socketPath, capability] = process.argv.slice(2);
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
        const value = await request(socketPath, { capability, operation, path: args.path, query: args.query, offset: args.offset, version: args.version });
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

module.exports = { request };
