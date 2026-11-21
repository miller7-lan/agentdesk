// 本机工作区：只读文件树、Git 改动、文件预览和技能。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { contained } = require('./app-config');

const mac = process.platform === 'darwin';
const IGNORE = new Set(['.git', '.tools', '__pycache__', 'node_modules', '.venv', '.pytest_cache', '.mypy_cache']);
const MAX_TREE = 3000;
const MAX_PREVIEW = 512 * 1024;
const SKILL_ROOTS = [path.join(os.homedir(), '.codex', 'skills'), path.join(os.homedir(), '.agents', 'skills')];
const SKILL_MAX_BYTES = 5 * 1024 * 1024;
const SKILL_MAX_FILES = 300;
const UPLOAD_MAX = 10 * 1024 * 1024;

async function inside(root, rel) {
  if (!root || typeof rel !== 'string' || !rel || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) ||
      rel.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[:\x00]/.test(part))) {
    throw new Error('路径超出工作区');
  }
  const abs = path.resolve(root, rel);
  if (!contained(root, abs)) throw new Error('路径超出工作区');
  try {
    const resolved = await fsp.realpath(abs);
    if (!contained(await fsp.realpath(root), resolved)) throw new Error('路径超出工作区');
    return resolved;
  } catch (error) {
    if (error.code === 'ENOENT') {
      const parent = path.dirname(rel);
      if (parent !== '.') await inside(root, parent);
      return abs;
    }
    throw error;
  }
}

function git(root, args, { okCodes = [0] } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-c', `safe.directory=${root.replace(/\\/g, '/')}`, '-c', 'core.quotepath=false', '-C', root, ...args],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({ ok: okCodes.includes(code), code, out: stdout || '', err: (stderr || (err && err.message) || '').trim() });
      });
  });
}

class Workspace extends EventEmitter {
  constructor(root = null, { skillRoots = SKILL_ROOTS } = {}) {
    super();
    this.root = root;
    this.skillRoots = skillRoots;
    this.watcher = null;
    this.timer = null;
  }

  setRoot(root) {
    if (this.root === root) return;
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = null;
    this.root = root;
    this.emit('changed');
  }

  async access() {
    const root = this.root;
    if (!root) return { ok: false, root, error: '当前项目没有本机工作区。' };
    try { await fsp.readdir(root); return { ok: true, root }; }
    catch (e) { return { ok: false, root, code: e.code, error: e.code === 'EPERM' || e.code === 'EACCES' ? '当前账户没有读取测试目录的权限' : e.message }; }
  }

  async tree() {
    const out = [];
    const walk = async (dir, rel, depth) => {
      if (out.length >= MAX_TREE || depth > 8) return;
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of ents) {
        if (out.length >= MAX_TREE) break;
        if (e.isDirectory() && IGNORE.has(e.name)) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        out.push({ path: r, name: e.name, dir: e.isDirectory(), depth });
        if (e.isDirectory()) await walk(path.join(dir, e.name), r, depth + 1);
      }
    };
    const root = this.root;
    if (root) await walk(root, '', 0);
    return { items: out, truncated: out.length >= MAX_TREE };
  }

  async read(rel, root = this.root) {
    const abs = await inside(root, rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('只能预览普通文件。');
    if (st.size > MAX_PREVIEW) return { tooLarge: true, size: st.size };
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
    return { text: buf.toString('utf8'), size: st.size };
  }

  // 改动列表：暂存区 + 工作区 + 未跟踪文件，带增删行数
  async changes() {
    const root = this.root;
    if (!root) return { repo: false, files: [] };
    const top = await git(root, ['rev-parse', '--show-prefix']);
    if (!top.ok) return { repo: false, files: [], error: /not a git repository/i.test(top.err) ? '' : top.err };
    if (top.out.trim()) return { repo: false, files: [] };
    const st = await git(root, ['status', '--porcelain=v1', '-uall', '-z']);
    if (!st.ok) return { repo: true, files: [], error: st.err };
    const files = new Map();
    const parts = st.out.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const x = parts[i]; const code = x.slice(0, 2); let p = x.slice(3);
      if (code[0] === 'R' || code[0] === 'C') i++;              // 重命名后面紧跟原路径
      files.set(p, { path: p, index: code[0], work: code[1], add: 0, del: 0, untracked: code === '??' });
    }
    const add = (out) => out.split('\n').filter(Boolean).forEach((l) => {
      const [a, d, ...rest] = l.split('\t'); const f = files.get(rest.join('\t'));
      if (f) { f.add += a === '-' ? 0 : +a; f.del += d === '-' ? 0 : +d; if (a === '-') f.binary = true; }
    });
    add((await git(root, ['diff', '--numstat'])).out);
    add((await git(root, ['diff', '--cached', '--numstat'])).out);
    for (const f of files.values()) if (f.untracked) {
      try { const r = await this.read(f.path, root); f.add = r.text ? r.text.split('\n').length - (r.text.endsWith('\n') ? 1 : 0) : 0; if (r.binary) f.binary = true; } catch {}
    }
    const branch = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).out.trim() || '(detached)';
    return { repo: true, branch, files: [...files.values()] };
  }

  async diff(rel) {
    const root = this.root;
    await inside(root, rel);
    const staged = await git(root, ['diff', '--cached', '--no-color', '--', rel]);
    const work = await git(root, ['diff', '--no-color', '--', rel]);
    let text = staged.out + work.out;
    if (!text.trim()) {                                          // 未跟踪文件：与空文件比较
      const u = await git(root, ['diff', '--no-index', '--no-color', '--', mac ? '/dev/null' : 'NUL', rel], { okCodes: [0, 1] });
      text = u.out;
    }
    return { text };
  }

  watch() {
    if (this.watcher || !this.root) return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, file) => {
        if (file && /(^|[\\/])(\.git[\\/](objects|logs)|__pycache__)/.test(file)) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.emit('changed'), 700);
      });
      this.watcher.on('error', () => { this.watcher = null; });
    } catch { this.watcher = null; }
  }

  /* ---------- 本机技能 ---------- */
  async localSkills() {
    const out = []; const seen = new Set();
    for (const root of this.skillRoots) {
      let ents; try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;   // .system 是 Codex 自带技能，VPS 上已有
        const dir = path.join(root, e.name);
        // skills-manager 等工具用符号链接安装技能，stat 会跟随链接；坏链接和普通文件直接跳过。
        let st; try { st = await fsp.stat(dir); } catch { continue; }
        if (!st.isDirectory()) continue;
        let md; try { md = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8'); } catch { continue; }
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
        const field = (k) => { const m = fm && new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm[1]); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
        const name = field('name') || e.name;
        if (seen.has(name)) continue;   // 两个技能根目录指向同一个技能时只列一次
        seen.add(name);
        out.push({ name, folder: e.name, description: field('description'), dir, source: 'local' });
      }
    }
    return out;
  }

  // 打包一个本机技能目录（相对路径 + base64），供上传到 VPS
  async packSkill(dir) {
    const files = []; let total = 0; const visited = new Set();
    const walk = async (d, rel) => {
      let real; try { real = await fsp.realpath(d); } catch { return; }
      if (visited.has(real)) return;   // 符号链接成环或重复目录只走一次
      visited.add(real);
      let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '__pycache__') continue;
        const abs = path.join(d, e.name); const r = rel ? rel + '/' + e.name : e.name;
        let st; try { st = await fsp.stat(abs); } catch { continue; }   // 跟随技能内的符号链接
        if (st.isDirectory()) { await walk(abs, r); continue; }
        if (!st.isFile()) continue;
        const buf = await fsp.readFile(abs);
        total += buf.length;
        if (total > SKILL_MAX_BYTES) throw new Error('技能目录超过 5 MB，未上传');
        if (files.length >= SKILL_MAX_FILES) throw new Error('技能文件超过 300 个，未上传');
        files.push({ rel: r, b64: buf.toString('base64'), mtime: st.mtimeMs });
      }
    };
    await walk(dir, '');
    const sig = files.map((f) => f.rel + ':' + f.mtime + ':' + f.b64.length).join('|');
    return { files, total, sig };
  }

  // 绝对路径在测试目录内 → 返回相对路径（用 / 分隔），否则返回 null
  relIfInside(p, targetRoot = this.root) {
    if (!targetRoot || typeof p !== 'string' || !path.isAbsolute(p)) return null;
    try {
      const root = fs.realpathSync(targetRoot);
      const absolute = fs.realpathSync(p);
      return contained(root, absolute) ? path.relative(root, absolute).split(path.sep).join('/') : null;
    } catch { return null; }
  }

  async readUpload(p) {
    const st = await fsp.stat(p);
    if (st.size > UPLOAD_MAX) throw new Error(`${path.basename(p)} 超过 10 MB`);
    return { name: path.basename(p), b64: (await fsp.readFile(p)).toString('base64'), size: st.size };
  }
}

module.exports = new Workspace();
module.exports.Workspace = Workspace;
