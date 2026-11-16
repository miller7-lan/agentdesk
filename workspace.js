// 本机工作区：C:\CodexSSH\windows-dev 的文件树、Git 改动、文件预览，以及本机技能的读取。
// 全部在 Windows 本地完成，不占用 VPS（1 GB 内存）资源；对测试目录只读。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const mac = process.platform === 'darwin';
const ROOT = mac ? path.join(os.homedir(), 'AgentDeskWorkspace') : 'C:\\CodexSSH\\windows-dev';
const ROOT_FWD = ROOT.replace(/\\/g, '/');
const IGNORE = new Set(['.git', '.tools', '__pycache__', 'node_modules', '.venv', '.pytest_cache', '.mypy_cache']);
const MAX_TREE = 3000;
const MAX_PREVIEW = 512 * 1024;
const SKILL_ROOTS = [path.join(os.homedir(), '.codex', 'skills'), path.join(os.homedir(), '.agents', 'skills')];
const SKILL_MAX_BYTES = 5 * 1024 * 1024;
const SKILL_MAX_FILES = 300;
const UPLOAD_MAX = 10 * 1024 * 1024;

function inside(rel) {
  const abs = path.resolve(ROOT, rel || '.');
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('路径超出工作区');
  return abs;
}

function git(args, { okCodes = [0] } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-c', `safe.directory=${ROOT_FWD}`, '-c', 'core.quotepath=false', '-C', ROOT, ...args],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({ ok: okCodes.includes(code), code, out: stdout || '', err: (stderr || (err && err.message) || '').trim() });
      });
  });
}

class Workspace extends EventEmitter {
  constructor() { super(); this.root = ROOT; this.watcher = null; this.timer = null; }

  async access() {
    try { await fsp.readdir(ROOT); return { ok: true, root: ROOT }; }
    catch (e) { return { ok: false, root: ROOT, code: e.code, error: e.code === 'EPERM' || e.code === 'EACCES' ? '当前账户没有读取测试目录的权限' : e.message }; }
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
    await walk(ROOT, '', 0);
    return { items: out, truncated: out.length >= MAX_TREE };
  }

  async read(rel) {
    const abs = inside(rel);
    if (mac && !(await fsp.realpath(abs)).startsWith((await fsp.realpath(ROOT)) + path.sep)) throw new Error('路径超出工作区');
    const st = await fsp.stat(abs);
    if (st.size > MAX_PREVIEW) return { tooLarge: true, size: st.size };
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
    return { text: buf.toString('utf8'), size: st.size };
  }

  // 改动列表：暂存区 + 工作区 + 未跟踪文件，带增删行数
  async changes() {
    const top = await git(['rev-parse', '--show-toplevel']);
    if (!top.ok) return { repo: false, files: [], error: /not a git repository/i.test(top.err) ? '' : top.err };
    const st = await git(['status', '--porcelain=v1', '-uall', '-z']);
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
    add((await git(['diff', '--numstat'])).out);
    add((await git(['diff', '--cached', '--numstat'])).out);
    for (const f of files.values()) if (f.untracked) {
      try { const r = await this.read(f.path); f.add = r.text ? r.text.split('\n').length - (r.text.endsWith('\n') ? 1 : 0) : 0; if (r.binary) f.binary = true; } catch {}
    }
    const branch = (await git(['symbolic-ref', '--short', '-q', 'HEAD'])).out.trim() || '(detached)';
    return { repo: true, branch, files: [...files.values()] };
  }

  async diff(rel) {
    inside(rel);
    const staged = await git(['diff', '--cached', '--no-color', '--', rel]);
    const work = await git(['diff', '--no-color', '--', rel]);
    let text = staged.out + work.out;
    if (!text.trim()) {                                          // 未跟踪文件：与空文件比较
      const u = await git(['diff', '--no-index', '--no-color', '--', mac ? '/dev/null' : 'NUL', rel], { okCodes: [0, 1] });
      text = u.out;
    }
    return { text };
  }

  watch() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(ROOT, { recursive: true }, (_ev, file) => {
        if (file && /(^|[\\/])(\.git[\\/](objects|logs)|__pycache__)/.test(file)) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.emit('changed'), 700);
      });
      this.watcher.on('error', () => { this.watcher = null; });
    } catch { this.watcher = null; }
  }

  /* ---------- 本机技能 ---------- */
  async localSkills() {
    const out = [];
    for (const root of SKILL_ROOTS) {
      let ents; try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;   // .system 是 Codex 自带技能，VPS 上已有
        const dir = path.join(root, e.name);
        let md; try { md = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8'); } catch { continue; }
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
        const field = (k) => { const m = fm && new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm[1]); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
        out.push({ name: field('name') || e.name, folder: e.name, description: field('description'), dir, source: 'local' });
      }
    }
    return out;
  }

  // 打包一个本机技能目录（相对路径 + base64），供上传到 VPS
  async packSkill(dir) {
    const files = []; let total = 0;
    const walk = async (d, rel) => {
      for (const e of await fsp.readdir(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '__pycache__') continue;
        const abs = path.join(d, e.name); const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { await walk(abs, r); continue; }
        const buf = await fsp.readFile(abs);
        total += buf.length;
        if (total > SKILL_MAX_BYTES) throw new Error('技能目录超过 5 MB，未上传');
        if (files.length >= SKILL_MAX_FILES) throw new Error('技能文件超过 300 个，未上传');
        files.push({ rel: r, b64: buf.toString('base64'), mtime: (await fsp.stat(abs)).mtimeMs });
      }
    };
    await walk(dir, '');
    const sig = files.map((f) => f.rel + ':' + f.mtime + ':' + f.b64.length).join('|');
    return { files, total, sig };
  }

  // 绝对路径在测试目录内 → 返回相对路径（用 / 分隔），否则返回 null
  relIfInside(p) {
    const abs = path.resolve(p); const low = abs.toLowerCase(); const root = ROOT.toLowerCase();
    if (low === root) return '';
    if (!low.startsWith(root + path.sep)) return null;
    return abs.slice(ROOT.length + 1).replace(/\\/g, '/');
  }

  async readUpload(p) {
    const st = await fsp.stat(p);
    if (st.size > UPLOAD_MAX) throw new Error(`${path.basename(p)} 超过 10 MB`);
    return { name: path.basename(p), b64: (await fsp.readFile(p)).toString('base64'), size: st.size };
  }
}

module.exports = new Workspace();
