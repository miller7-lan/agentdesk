const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

const TOOL = /^desktop_(?!sandbox_|trace_|cursor_overlay_|session_|skills_|permissions$|batch$)[a-z_]+$/;
const MAX_IMAGE = 20 * 1024 * 1024;
const text = (value) => ({ type: 'inputText', text: value });
const failure = (message) => ({ success: false, contentItems: [text(message)] });

class Desktop {
  constructor(executable) {
    this.executable = executable;
    this.enabled = true;
    this.active = new Map();
    this.pending = new Map();
    this.id = 0;
    this.tools = null;
    this.timeoutMs = 40_000;
    this.timeouts = 0;          // consecutive timeouts; the backend is restarted after three
  }

  async start() {
    const child = spawn(this.executable, ['mcp', '--headed', '--session', 'agentdesk'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child = child;
    const close = (reason) => {
      if (this.child !== child) return;
      this.stop(reason);
    };
    child.once('error', (error) => close(error.message));
    child.once('exit', () => close('Windows desktop backend exited'));
    child.stdin.on('error', (error) => close(error.message));
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.child !== child) return;
      let response;
      try { response = JSON.parse(line); } catch { return; }
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      clearTimeout(request.timer);
      this.timeouts = 0;
      if (response.error) request.reject(new Error(response.error.message));
      else request.resolve(response.result);
    });
    await this.send('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'AgentDesk', version: require('./package.json').version },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const { tools } = await this.send('tools/list', {});
    this.tools = new Map(tools.filter(({ name }) => TOOL.test(name)).map((tool) => {
      const inputSchema = structuredClone(tool.inputSchema);
      if (tool.name === 'desktop_screenshot') delete inputSchema.properties.output_path;
      if (tool.name === 'desktop_launch') delete inputSchema.properties.cdp;
      const prefix = 'Operate the local desktop in the signed-in AgentDesk account. ';
      const description = prefix + tool.description;
      return [tool.name, { type: 'function', name: tool.name, description, inputSchema }];
    }));
    return [...this.tools.values()];
  }

  specs() {
    if (!this.enabled) return Promise.resolve([]);
    if (!this.initialization) {
      this.initialization = this.start().catch((error) => {
        this.stop(error.message);
        throw error;
      });
    }
    return this.initialization;
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('Windows desktop operation timed out'));
        if (++this.timeouts >= 3) this.stop('Windows desktop backend stopped responding');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  stop(message = 'Windows desktop control stopped') {
    const child = this.child;
    this.child = null;
    this.initialization = null;
    this.tools = null;
    this.active.clear();
    child?.kill();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.pending.clear();
  }

  async call({ threadId, turnId, namespace, tool, arguments: args }) {
    if (!this.enabled) return failure('Windows desktop control is disabled in AgentDesk');
    if (!this.active.has(turnId) || this.active.get(turnId) !== threadId) return failure('Windows desktop calls require an active AgentDesk turn');
    if (namespace || !this.tools?.has(tool)) return failure('Unknown Windows desktop tool');
    if (!args || typeof args !== 'object' || Array.isArray(args)) return failure('Expected desktop tool arguments');
    const { inputSchema } = this.tools.get(tool);
    if (Object.keys(args).some((key) => !Object.hasOwn(inputSchema.properties || {}, key))) {
      return failure('Unsupported desktop tool argument');
    }
    try {
      const reply = await this.send('tools/call', { name: tool, arguments: args });
      if (!this.enabled || this.active.get(turnId) !== threadId) return failure('Windows desktop access ended');
      const contentItems = [];
      let success = !reply.isError;
      for (const item of reply.content || []) {
        if (item.type === 'image' && /^image\/(png|jpeg|webp)$/.test(item.mimeType) &&
            typeof item.data === 'string' && item.data.length <= MAX_IMAGE) {
          contentItems.push({ type: 'inputImage', imageUrl: 'data:' + item.mimeType + ';base64,' + item.data });
        } else if (item.type === 'text' && typeof item.text === 'string') {
          let envelope;
          try { envelope = JSON.parse(item.text); } catch {}
          if (envelope?.ok === false) success = false;
          const png = envelope?.data?.base64 || envelope?.data?.png_base64;
          if (tool === 'desktop_screenshot' && typeof png === 'string' && png.length <= MAX_IMAGE) {
            contentItems.push({ type: 'inputImage', imageUrl: 'data:image/png;base64,' + png });
          } else contentItems.push(text(item.text.slice(0, 120_000)));
        }
      }
      return contentItems.length ? { success, contentItems } : failure('Desktop backend returned no supported content');
    } catch (error) {
      return failure(error.message);
    }
  }
}

function desktopExecutable(app) {
  const directory = app.isPackaged ? process.resourcesPath : __dirname;
  const filename = process.platform === 'darwin'
    ? 'agent-desktop-darwin-' + process.arch : 'agent-desktop-win32-x64.exe';
  return path.join(directory, 'desktop-backend', filename);
}

module.exports = { Desktop, desktopExecutable };
