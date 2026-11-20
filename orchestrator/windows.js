const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { homedir, tmpdir } = require('node:os');
const { MAX_PATCH } = require('./task-output');
const { messageId } = require('./transport');
const { attachmentRoot, idPattern } = require('./attachments');
const { readBatch, writeBatch, editFile } = require('./file-batch');
const { searchFiles } = require('./file-search');

const CHUNK = 64 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const validDigest = (value) => /^[a-f0-9]{64}$/.test(value);

// Content search for agents: finds lines containing the query in text files under a project path.
// Skips symlinks, version-control and dependency folders, binary files and files over 1 MB; capped in
// files visited, matches and response size like the name search.
const GREP_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache']);
async function grep(start, body, skip = () => false) {
  if (typeof body.query !== 'string' || !body.query || body.query.length > 200) throw new Error('invalid_query');
  const sensitive = body.caseSensitive === true;
  const needle = sensitive ? body.query : body.query.toLowerCase();
  const matches = [];
  let visited = 0;
  let size = 0;
  let truncated = false;
  async function scan(file, rel) {
    const stat = await fs.stat(file);
    if (stat.size > 1024 * 1024) return;
    const bytes = await fs.readFile(file);
    if (bytes.subarray(0, 8000).includes(0)) return;
    const lines = bytes.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!(sensitive ? lines[index] : lines[index].toLowerCase()).includes(needle)) continue;
      const text = lines[index].trim().slice(0, 200);
      size += rel.length + text.length + 24;
      matches.push({ path: rel, line: index + 1, text });
      if (matches.length >= 200 || size >= 12000) { truncated = true; return; }
    }
  }
  async function walk(dir, prefix) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (truncated) return;
      if (++visited > 5000) { truncated = true; return; }
      if (entry.isSymbolicLink() || GREP_SKIP.has(entry.name.toLowerCase()) || skip(path.join(dir, entry.name))) continue;
      const rel = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel + '/');
      else if (entry.isFile()) await scan(path.join(dir, entry.name), rel);
    }
  }
  if ((await fs.stat(start)).isDirectory()) await walk(start, body.path ? body.path + '/' : '');
  else await scan(start, body.path);
  return { matches, truncated };
}

// The lead may ask for the read-only "computer" location: the person's home folder, mounted volumes and
// temporary folders. Writes and commands never use it. System locations and credential stores stay out,
// including everything under ~/Library on macOS and the Windows credential folders.
const HOME = homedir();
const REAL_HOME = realSync(HOME);
const TEMP_ROOTS = [...new Set([tmpdir(), realSync(tmpdir()), '/tmp', '/private/tmp'])];
const ALLOWED_ROOTS = [...new Set([HOME, REAL_HOME, '/Volumes', ...TEMP_ROOTS])];
const SYSTEM_ROOTS = process.platform === 'win32'
  ? [process.env.SystemRoot, 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\$Recycle.Bin',
    'C:\\Recovery', 'C:\\System Volume Information', 'C:\\PerfLogs', 'C:\\Windows.old']
  : ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/var', '/private/var', '/opt',
    '/Applications', '/dev', '/cores', '/private/cores', '/private/auditd', '/private/db', '/private/log',
    '/private/root', '/private/Network', '/lib', '/lib64', '/boot', '/proc', '/sys', '/root', '/run', '/snap'];
const HOME_DENY = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.agentdesk', '.password-store',
  '.codex', '.claude', '.gemini', '.grok', '.config/grok', '.config/gh', '.config/gcloud',
  '.local/share/keyrings', 'Library',
  'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/gcloud',
  'AppData/Roaming/AgentDesk', 'AppData/Local/AgentDesk',
  'AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data',
  'AppData/Roaming/Mozilla/Firefox/Profiles',
].flatMap((name) => [path.join(HOME, name), path.join(REAL_HOME, name)]);
const DENY_FILES = new Set(['.netrc', '.npmrc', '.git-credentials', '.pgpass', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']);
const fold = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const under = (value, root) => value === root || value.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function realSync(value) {
  try { return require('node:fs').realpathSync.native(value); } catch { return value; }
}

function allowedAnywhere(candidate) {
  const value = fold(candidate);
  const temp = TEMP_ROOTS.some((root) => under(value, fold(root)));
  const allowed = process.platform === 'win32'
    ? /^[a-z]:\\/i.test(candidate) && !candidate.startsWith('\\\\')
    : ALLOWED_ROOTS.some((root) => under(value, fold(root)));
  if (!allowed) throw new Error('path_not_allowed');
  if (!temp && SYSTEM_ROOTS.filter(Boolean).some((root) => under(value, fold(path.resolve(root))))) {
    throw new Error('path_not_allowed');
  }
  if (process.platform === 'win32') {
    const drive = path.parse(candidate).root;
    if (/^(?:\$recycle\.bin|system volume information|recovery|perflogs)$/i.test(candidate.slice(drive.length).split(path.sep)[0])) {
      throw new Error('path_not_allowed');
    }
  }
  if (HOME_DENY.some((root) => under(value, fold(root)))) throw new Error('credential_path_denied');
  if (DENY_FILES.has(path.basename(candidate).toLowerCase())) throw new Error('credential_path_denied');
  if (candidate.split(path.sep).some((part) => part.toLowerCase() === '.git')) throw new Error('git_path_denied');
  if (process.platform !== 'win32' && candidate === path.sep) throw new Error('path_not_allowed');
}

const allowedAnywherePath = (value) => { try { allowedAnywhere(value); return true; } catch { return false; } };

// Absolute paths for the computer location: "" or "~" means the home folder, "~/..." is expanded, and
// symbolic links are resolved before the allow/deny checks so they cannot reach a forbidden location.
async function anyPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f]/.test(value)) throw new Error('invalid_path');
  let requested = value;
  if (requested === '' || requested === '~') requested = HOME;
  else if (/^~[\\/]/.test(requested)) requested = path.join(HOME, requested.slice(2));
  if (!path.isAbsolute(requested)) throw new Error('invalid_path');
  const normalized = path.resolve(requested);
  allowedAnywhere(normalized);
  let actual;
  try { actual = await fs.realpath(normalized); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('invalid_path');
    throw error;
  }
  allowedAnywhere(actual);
  return actual;
}

async function within(root, relative, { missing = false, directory = false } = {}) {
  if (typeof relative !== 'string' || (relative === '' && !directory) || relative.length > 1024 ||
      (relative && relative.split('/').some((part) =>
        !part || /^\.{1,2}$/.test(part) || part.toLowerCase() === '.git' ||
        /[\\:<>"|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new Error('invalid_path');
  let target = root;
  const parts = relative ? relative.split('/') : [];
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    try {
      const entry = await fs.lstat(target);
      if (entry.isSymbolicLink()) throw new Error('symlink_denied');
      const resolved = await fs.realpath(target);
      const resolvedRelative = path.relative(root, resolved);
      if (resolvedRelative.startsWith('..' + path.sep) || resolvedRelative === '..' || path.isAbsolute(resolvedRelative)) {
        throw new Error('path_escape');
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || index !== parts.length - 1 || !missing) throw error;
    }
  }
  return target;
}

async function version(filename) {
  const stat = await fs.lstat(filename);
  if (stat.isDirectory()) return { type: 'directory', version: sha(String(stat.mtimeMs)), size: 0 };
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('unsupported_file');
  return { type: 'file', version: sha(await fs.readFile(filename)), size: stat.size };
}

async function checkVersion(filename, expected) {
  if (expected !== null && !validDigest(expected)) throw new Error('expected_version_required');
  const current = await version(filename).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if ((current?.version ?? null) !== expected) throw new Error('version_conflict');
  return current;
}

function execute(root, binary, args, timeout, signal, env = process.env, outputLimit = 16000) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    let failure;
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.once('exit', (code) => { if (code) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    };
    const timer = setTimeout(() => stop(new Error('command_timeout')), timeout);
    const abort = () => stop(signal.reason);
    const output = { stdout: '', stderr: '' };
    let truncated = false;
    signal.addEventListener('abort', abort, { once: true });
    for (const channel of Object.keys(output)) {
      child[channel].setEncoding('utf-8').on('data', (chunk) => {
        const combined = output[channel] + chunk;
        if (channel === 'stdout' && combined.length > outputLimit) truncated = true;
        output[channel] = combined.slice(-outputLimit);
      });
    }
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code, ...output, ...(truncated && { truncated }) });
    });
  });
}

class WindowsOperations {
  constructor({ config, store, desktop, recycle }) {
    this.config = config;
    this.store = store;
    this.desktop = desktop;
    this.recycle = recycle;
    this.commands = new Map();
    this.busyStreams = new Set();
    this.busy = new Set();
  }

  async call(frame) {
    const { task_id: taskId, message_id: requestId, kind, body } = frame;
    if (kind === 'task.status' && body.operation === 'stream_status') {
      const record = this.stream(taskId, body.stream_id);
      return { stream_id: body.stream_id, next_offset: record.offset, state: record.closed ? 'complete' : 'open' };
    }
    if (kind === 'command.execute' && body.operation === 'cancel') {
      const command = this.commands.get(body.request_id);
      if (command?.taskId === taskId) command.controller.abort(new Error('command_cancelled'));
      return { state: command?.taskId === taskId ? 'cancelling' : 'unknown' };
    }
    if (['stream.open', 'stream.chunk', 'stream.end'].includes(kind)) {
      const id = body.stream_id;
      if (this.busyStreams.has(id)) throw new Error('stream_busy');
      this.busyStreams.add(id);
      try {
        if (kind === 'stream.open') return await this.open(taskId, body);
        if (kind === 'stream.chunk') return await this.chunk(taskId, body);
        return await this.end(taskId, body);
      } finally {
        this.busyStreams.delete(id);
      }
    }
    if (kind === 'file.read' && body.operation === 'artifact') return this.artifact(taskId, body);
    if (kind === 'file.read' && body.operation === 'chat_attachment') {
      if (typeof body.attachmentId !== 'string' || !idPattern.test(body.attachmentId)) throw Error('invalid_attachment');
      const root = await fs.realpath(attachmentRoot(this.config.stateDir, taskId));
      const filename = await within(root, body.attachmentId);
      const info = await fs.stat(filename);
      if (!info.isFile() || info.size > MAX_FILE) throw Error('invalid_attachment');
      return this.readChunk(filename, info.size, body.offset);
    }
    const workspaceName = body.workspace;
    const workspace = Object.hasOwn(this.config.workspaces, workspaceName) && this.config.workspaces[workspaceName];
    if (!workspace) throw new Error('workspace_not_authorized');
    if (kind === 'file.read') {
      const roots = workspace.readRoots || {};
      const anyFolder = this.config.readAnyFolder === true || workspace.readAnyFolder === true;
      if (body.operation === 'locations') return { locations: [
        { id: 'project', label: '项目' },
        ...(anyFolder ? [{ id: 'computer', label: this.config.writeAnyFolder === true || workspace.writeAnyFolder === true ? '本机（任意文件夹，改文件的步骤可写）' : '本机（只读）' }] : []),
        ...Object.keys(roots).filter((id) => id !== 'project' && id !== 'computer').map((id) => ({ id, label: id === 'desktop' ? '桌面' : id })),
      ] };
      const selected = body.root ?? 'project';
      const search = body.operation === 'glob' || body.operation === 'grep_context';
      const grep = body.operation === 'grep_context';
      if (selected === 'computer') {
        // The orchestrator only sets anyFolder for the lead; the bridge config must also allow it.
        if (!anyFolder || body.anyFolder !== true) throw new Error('read_root_not_authorized');
        if (body.operation === 'read_batch') return readBatch(body.items, anyPath);
        if (search) return searchFiles(body, anyPath, grep);
        return this.readTarget(await anyPath(body.path), body);
      }
      if (selected !== 'project' && (typeof selected !== 'string' || !Object.hasOwn(roots, selected))) throw new Error('read_root_not_authorized');
      const readRoot = await fs.realpath(selected === 'project' ? workspace.root : roots[selected]);
      if (body.operation === 'read_batch') return readBatch(body.items, (filename) => within(readRoot, filename));
      if (search) {
        const resolve = (filename) => within(readRoot, path.relative(readRoot, filename).split(path.sep).join('/'), { directory: true });
        const directory = await within(readRoot, body.path, { directory: true });
        return searchFiles({ ...body, path: directory }, resolve, grep);
      }
      return this.read(readRoot, body);
    }
    if (kind === 'file.write' && body.root === 'computer') {
      // Writing in any folder needs both switches on this computer (readAnyFolder and writeAnyFolder) and the
      // orchestrator's anyFolder mark, which it only sets for steps that change files.
      const writable = (this.config.readAnyFolder === true || workspace.readAnyFolder === true) &&
        (this.config.writeAnyFolder === true || workspace.writeAnyFolder === true);
      if (!writable || body.anyFolder !== true) throw new Error('read_root_readonly');
      const project = await fs.realpath(workspace.root);
      if (body.operation === 'write_batch') {
        return writeBatch(body.items, (filename) => this.anyWritePath(project, filename));
      }
      if (body.operation === 'edit') {
        const result = await editFile(body, (filename) => this.anyWritePath(project, filename));
        return { ...result, type: 'file', size: result.bytes };
      }
      return this.writeAnywhere(taskId, project, body);
    }
    if (body.root !== undefined && body.root !== 'project') throw new Error('read_root_readonly');
    const root = await fs.realpath(workspace.root);
    if (kind === 'task.request' && body.operation === 'desktop') {
      if (workspace.desktop !== true || !this.desktop.enabled || !/^desktop_(?:click|double_click|right_click|move|drag|scroll|type|press|key|screenshot|mouse_move|mouse_click|mouse_drag|mouse_wheel|snapshot|find|type_text|press_key)$/.test(body.tool)) {
        throw new Error('desktop_not_authorized');
      }
      await this.desktop.specs();
      this.desktop.active.set(requestId, taskId);
      try {
        const reply = await this.desktop.call({ threadId: taskId, turnId: requestId, tool: body.tool, arguments: body.arguments });
        const contentItems = [];
        for (const item of reply.contentItems) {
          if (item.type === 'inputImage') {
            const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(item.imageUrl) || [];
            if (data) contentItems.push({ type: 'artifact', mimeType, ...await this.saveArtifact(taskId, Buffer.from(data, 'base64')) });
          } else contentItems.push({ type: 'text', text: item.text.slice(0, 10000) });
        }
        return { success: reply.success, contentItems };
      } finally {
        this.desktop.active.delete(requestId);
      }
    }
    if (this.busy.has(root)) throw new Error('workspace_busy');
    this.busy.add(root);
    try {
      if (kind === 'command.execute') return await this.command(taskId, requestId, workspace, root, body);
      if (!workspace.write) throw new Error('workspace_write_denied');
      if (kind === 'file.write') return await this.write(taskId, root, body);
      if (kind === 'file.patch' && body.operation === 'apply') return await this.patch(taskId, root, body);
      throw new Error('unsupported_operation');
    } finally {
      this.busy.delete(root);
    }
  }

  async sweepStreams(now = Date.now()) {
    for (const stream of this.store.all('streams')) {
      if (stream.id && stream.updated < now - 24 * 60 * 60 * 1000 && !this.busyStreams.has(stream.id)) {
        this.busyStreams.add(stream.id);
        try {
          await fs.rm(this.streamPath(stream.id), { force: true });
          this.store.delete('streams', stream.id);
        } finally {
          this.busyStreams.delete(stream.id);
        }
      }
    }
  }

  stream(taskId, id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid_stream');
    const record = this.store.get('streams', id);
    if (!record || record.taskId !== taskId) throw new Error('unknown_stream');
    return record;
  }

  streamPath(id) {
    return path.join(this.config.stateDir, 'streams', id);
  }

  async open(taskId, { stream_id: id, size }) {
    if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) throw new Error('invalid_stream');
    const existing = this.store.get('streams', id);
    if (existing) {
      if (existing.taskId !== taskId || existing.size !== size) throw new Error('stream_conflict');
      return { next_offset: existing.offset };
    }
    const allocated = this.store.all('streams').reduce((sum, stream) => sum + stream.size, 0);
    if (allocated + size > 1024 * 1024 * 1024) throw new Error('stream_capacity');
    await fs.mkdir(path.dirname(this.streamPath(id)), { recursive: true });
    await fs.writeFile(this.streamPath(id), '', { flag: 'wx', mode: 0o600 });
    this.store.put('streams', id, { id, taskId, size, offset: 0, updated: Date.now() });
    return { next_offset: 0 };
  }

  async chunk(taskId, { stream_id: id, offset, data, sha256 }) {
    const record = this.stream(taskId, id);
    const bytes = decode(data);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.offset ||
        !bytes.length || offset + bytes.length > record.size || sha(bytes) !== sha256) throw new Error('invalid_chunk');
    const file = await fs.open(this.streamPath(id), 'r+');
    try {
      if (offset < record.offset) {
        if (offset + bytes.length > record.offset) throw new Error('chunk_conflict');
        const check = Buffer.alloc(bytes.length);
        await file.read(check, 0, check.length, offset);
        if (!bytes.equals(check)) throw new Error('chunk_conflict');
        return { next_offset: record.offset };
      }
      if (record.closed) throw new Error('stream_closed');
      if ((await file.write(bytes, 0, bytes.length, offset)).bytesWritten !== bytes.length) throw new Error('short_write');
      await file.sync();
      record.offset += bytes.length;
      this.store.put('streams', id, { ...record, updated: Date.now() });
      return { next_offset: record.offset };
    } finally {
      await file.close();
    }
  }

  async end(taskId, { stream_id: id, size, sha256 }) {
    const record = this.stream(taskId, id);
    const bytes = await fs.readFile(this.streamPath(id));
    if (record.size !== size || record.offset !== size || bytes.length !== size || sha(bytes) !== sha256) throw new Error('stream_checksum_mismatch');
    this.store.put('streams', id, { ...record, closed: true, updated: Date.now() });
    return { size, sha256 };
  }

  async saveArtifact(taskId, bytes) {
    const id = randomUUID();
    await this.open(taskId, { stream_id: id, size: bytes.length });
    await fs.writeFile(this.streamPath(id), bytes);
    this.store.put('streams', id, { id, taskId, size: bytes.length, offset: bytes.length, closed: true, updated: Date.now() });
    return { stream_id: id, size: bytes.length, sha256: sha(bytes) };
  }

  async artifact(taskId, body) {
    const record = this.stream(taskId, body.stream_id);
    if (!record.closed) throw new Error('stream_incomplete');
    return this.readChunk(this.streamPath(body.stream_id), record.size, body.offset);
  }

  async readChunk(filename, size, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error('invalid_offset');
    const file = await fs.open(filename, 'r');
    try {
      const chunk = Buffer.alloc(Math.min(size - offset, CHUNK));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (bytesRead !== chunk.length) throw new Error('file_changed');
      return { offset, size, data: chunk.toString('base64'), sha256: sha(chunk) };
    } finally {
      await file.close();
    }
  }

  async read(root, body) {
    return this.readTarget(await within(root, body.path, { directory: true }), body, root);
  }

  async readTarget(filename, body, root) {
    if (body.operation === 'stat') return version(filename);
    if (body.operation === 'list' || body.operation === 'search') {
      const items = [];
      const search = body.operation === 'search';
      let visited = 0;
      let responseSize = 0;
      if (search && (typeof body.query !== 'string' || !body.query || body.query.length > 200)) throw new Error('invalid_query');
      async function walk(dir, prefix) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (++visited > 10000 || items.length >= 500 || responseSize >= 12000) return;
          if (entry.isSymbolicLink() || entry.name.toLowerCase() === '.git') continue;
          const rel = prefix + entry.name;
          if (!search || rel.toLowerCase().includes(body.query.toLowerCase())) {
            responseSize += rel.length + 35;
            items.push({ path: rel, directory: entry.isDirectory() });
          }
          if (search && entry.isDirectory()) {
            await walk(root === undefined ? path.join(dir, entry.name) : await within(root, rel, { directory: true }), rel + '/');
          }
        }
      }
      await walk(filename, body.path ? body.path + '/' : '');
      return { items, truncated: visited > 10000 || items.length >= 500 || responseSize >= 12000 };
    }
    if (body.operation === 'grep') {
      return grep(filename, body, root === undefined ? (entry) => !allowedAnywherePath(entry) : undefined);
    }
    if (body.operation !== 'read') throw new Error('unsupported_file_operation');
    const metadata = await version(filename);
    if (metadata.type !== 'file' || (body.version && metadata.version !== body.version)) throw new Error('version_conflict');
    return { ...await this.readChunk(filename, metadata.size, body.offset), version: metadata.version };
  }

  // A file or folder anywhere the computer location allows, by absolute path. The same checks as reading
  // (system, credential and .git paths refused; links resolved first) apply to the target and to its folder,
  // which must exist. The project folder itself only changes through reviewed patches. Overwrites name the
  // version they replace; deletions go to the trash.
  async anyWritePath(project, value, { existing = false } = {}) {
      if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f]/.test(value)) throw new Error('invalid_path');
      let requested = value;
      if (/^~[\\/]/.test(requested)) requested = path.join(HOME, requested.slice(2));
      if (!path.isAbsolute(requested)) throw new Error('invalid_path');
      const target = existing ? await anyPath(requested) : path.join(await anyPath(path.dirname(path.resolve(requested))), path.basename(requested));
      allowedAnywhere(target);
      if (/^\.{1,2}$/.test(path.basename(target))) throw new Error('invalid_path');
      const relative = path.relative(project, target);
      if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('project_write_denied: change project files in the task workspace; they are applied as a reviewed patch');
      }
      return target;
  }

  async writeAnywhere(taskId, project, body) {
    const place = (value, options) => this.anyWritePath(project, value, options);
    const key = 'any:' + body.path;
    if (this.busy.has(key)) throw new Error('workspace_busy');
    this.busy.add(key);
    try {
      if (body.operation === 'mkdir') {
        const target = await place(body.path);
        await checkVersion(target, null);
        await fs.mkdir(target);
        return version(target);
      }
      if (body.operation === 'move') {
        const source = await place(body.path, { existing: true });
        await checkVersion(source, body.version);
        const destination = await place(body.destination);
        await checkVersion(destination, null);
        await fs.rename(source, destination);
        return version(destination);
      }
      if (body.operation === 'delete') {
        const target = await place(body.path, { existing: true });
        await checkVersion(target, body.version);
        if (!this.recycle) throw new Error('recycle_unavailable');
        await this.recycle(target);
        return { deleted: true };
      }
      if (body.operation !== 'write') throw new Error('invalid_file_operation');
      const target = await place(body.path);
      const current = await checkVersion(target, body.version);
      if (current?.type === 'directory') throw new Error('invalid_file_operation');
      const record = this.stream(taskId, body.stream_id);
      if (!record.closed) throw new Error('stream_incomplete');
      const temporary = path.join(path.dirname(target), '.agentdesk-' + randomUUID());
      try {
        await fs.copyFile(this.streamPath(body.stream_id), temporary, require('node:fs').constants.COPYFILE_EXCL);
        await checkVersion(target, body.version);
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return version(target);
    } finally {
      this.busy.delete(key);
    }
  }

  async write(taskId, root, body) {
    const filename = await within(root, body.path, { missing: true });
    const current = await checkVersion(filename, body.version);
    if (body.operation === 'mkdir' && !current) {
      await fs.mkdir(filename);
    } else if (body.operation === 'move' && current) {
      const destination = await within(root, body.destination, { missing: true });
      await checkVersion(destination, null);
      await fs.rename(filename, destination);
      return version(destination);
    } else if (body.operation === 'delete' && current) {
      if (!this.recycle) throw new Error('recycle_unavailable');
      await this.recycle(filename);
      return { deleted: true };
    } else if (body.operation === 'write' && current?.type !== 'directory') {
      const record = this.stream(taskId, body.stream_id);
      if (!record.closed) throw new Error('stream_incomplete');
      const temporary = path.join(path.dirname(filename), '.agentdesk-' + randomUUID());
      try {
        await fs.copyFile(this.streamPath(body.stream_id), temporary, require('node:fs').constants.COPYFILE_EXCL);
        await checkVersion(filename, body.version);
        await fs.rename(temporary, filename);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    } else {
      throw new Error('invalid_file_operation');
    }
    return version(filename);
  }

  git(root, args, signal, env, limit) {
    return execute(root, this.config.git || 'git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], 30000, signal, env, limit);
  }

  async baseline(root, signal) {
    const head = await this.git(root, ['rev-parse', 'HEAD'], signal);
    const status = await this.git(root, ['status', '--porcelain'], signal);
    if (head.code || status.code) throw new Error('git_status_failed');
    return { head: head.stdout.trim(), clean: !status.stdout };
  }

  async reviewDiff(root, signal) {
    const { head } = await this.baseline(root, signal);
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'agentdesk-review-'));
    try {
      // 临时索引包括未跟踪文件，保留工作区真正的暂存区。
      const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, 'index'), GIT_OPTIONAL_LOCKS: '0' };
      for (const args of [['read-tree', head], ['add', '--all']]) {
        if ((await this.git(root, args, signal, env)).code !== 0) throw new Error('review_snapshot_failed');
      }
      const result = await this.git(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', head], signal, env, MAX_PATCH);
      if (result.code !== 0) throw new Error('review_snapshot_failed');
      if (result.truncated || Buffer.byteLength(result.stdout) > MAX_PATCH) throw new Error('patch_too_large');
      if ((await this.baseline(root, signal)).head !== head) throw new Error('plan_workspace_changed');
      return { base: head, patch: result.stdout };
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async patch(taskId, root, body) {
    const record = this.stream(taskId, body.stream_id);
    if (!record.closed) throw new Error('stream_incomplete');
    const signal = new AbortController().signal;
    const before = await this.baseline(root, signal);
    if (!before.clean || before.head !== body.base) throw new Error('version_conflict');
    const filename = this.streamPath(body.stream_id);
    const args = ['apply', '--binary', '--whitespace=nowarn', '--index', filename];
    if ((await this.git(root, ['apply', '--check', ...args.slice(1)], signal)).code !== 0) throw new Error('patch_conflict');
    if ((await this.git(root, args, signal)).code !== 0) throw new Error('patch_apply_failed');
    return { applied: true, base: before.head };
  }

  async command(taskId, id, workspace, root, body) {
    const controller = new AbortController();
    if (body.operation === 'git_baseline') return this.baseline(root, controller.signal);
    // Where this workspace sits inside the folder the read-only mount serves (the home folder, "/"-separated),
    // or null when it is outside it.
    if (body.operation === 'mount_info') {
      const base = this.config.mountRoot || homedir();
      const relative = path.relative(base, root);
      return { relative: !relative || relative.startsWith('..') || path.isAbsolute(relative) ? (relative ? null : '') : relative.split(path.sep).join('/') };
    }
    if (body.operation === 'git_review_diff') return this.reviewDiff(root, controller.signal);
    // Agents see and run only the commands this workspace lists in agentCommands (empty by default).
    const forAgents = Array.isArray(workspace.agentCommands) ? workspace.agentCommands.filter((name) => Array.isArray(workspace.commands?.[name])) : [];
    if (body.operation === 'list_agent_commands') {
      return { commands: forAgents.map((name) => ({ name, program: path.basename(workspace.commands[name][0]), args: workspace.commands[name].slice(1, 21) })) };
    }
    if (body.permission === 'agent' && !forAgents.includes(body.command)) throw new Error('command_not_enabled_for_agents');
    const spec = Object.hasOwn(workspace.commands || {}, body.command) && workspace.commands[body.command];
    if (body.operation !== 'run' || !['development', 'agent'].includes(body.permission) || !Array.isArray(spec) ||
        !spec.length || spec.some((arg) => typeof arg !== 'string') ||
        !Number.isSafeInteger(body.timeout_ms) || body.timeout_ms < 1 || body.timeout_ms > 900000) {
      throw new Error('command_not_authorized');
    }
    this.commands.set(id, { taskId, controller });
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key)));
      return await execute(root, spec[0], spec.slice(1), body.timeout_ms, controller.signal, env);
    } finally {
      this.commands.delete(id);
    }
  }
}

function decode(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(CHUNK / 3) * 4) throw new Error('invalid_chunk');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data || bytes.length > CHUNK) throw new Error('invalid_chunk');
  return bytes;
}

class RemoteFiles {
  constructor(endpoint) {
    this.endpoint = endpoint;
  }

  call(route, id, kind, body, timeout, signal) {
    signal?.throwIfAborted();
    return this.endpoint.request(route, id, kind, body, timeout, messageId(), signal);
  }

  async upload(route, taskId, bytes, id = randomUUID()) {
    if (bytes.length > MAX_FILE) throw new Error('file_too_large');
    const opened = await this.call(route, taskId, 'stream.open', { stream_id: id, size: bytes.length });
    if (!Number.isSafeInteger(opened.next_offset) || opened.next_offset < 0 || opened.next_offset > bytes.length ||
        (opened.next_offset !== bytes.length && opened.next_offset % CHUNK)) throw new Error('invalid_stream_offset');
    for (let offset = opened.next_offset; offset < bytes.length; offset += CHUNK) {
      const chunk = bytes.subarray(offset, offset + CHUNK);
      await this.call(route, taskId, 'stream.chunk', {
        stream_id: id, offset, data: chunk.toString('base64'), sha256: sha(chunk),
      });
    }
    await this.call(route, taskId, 'stream.end', { stream_id: id, size: bytes.length, sha256: sha(bytes) });
    return id;
  }

  async download(route, taskId, body, signal) {
    const chunks = [];
    let size;
    let version = body.version;
    for (let offset = 0; size === undefined || offset < size;) {
      const chunk = await this.call(route, taskId, 'file.read', { ...body, version, offset }, undefined, signal);
      const bytes = decode(chunk.data);
      size ??= chunk.size;
      version ??= chunk.version;
      if (!Number.isSafeInteger(size) || size > MAX_FILE || size < 0 || chunk.size !== size ||
          chunk.offset !== offset || chunk.sha256 !== sha(bytes) || (!bytes.length && offset < size) ||
          offset + bytes.length > size || (chunk.version && chunk.version !== version)) throw new Error('invalid_download');
      chunks.push(bytes);
      offset += bytes.length;
    }
    const buffer = Buffer.concat(chunks);
    if ((version || body.sha256) && sha(buffer) !== (version || body.sha256)) throw new Error('download_checksum_mismatch');
    return buffer;
  }

  async patch(route, taskId, workspace, base, bytes, requestId, signal) {
    const id = await this.upload(route, taskId, bytes);
    signal?.throwIfAborted();
    return this.endpoint.request(route, taskId, 'file.patch',
      { operation: 'apply', workspace, base, stream_id: id }, 90000, requestId, signal);
  }
}

module.exports = { WindowsOperations, RemoteFiles, within };
