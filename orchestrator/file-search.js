const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { encode } = require('./transport');

const excluded = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.ssh', '.aws', '.gnupg', '.kube',
  '.agentdesk', '.codex', '.claude', '.gemini', '.grok']);
const sensitive = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.git-credentials|id_(?:rsa|ed25519)(?:\..*)?)$/i;

function searchSpec(name, grep) {
  return {
    type: 'function', name,
    description: grep
      ? 'Find literal text in local files, with line numbers and optional surrounding lines. Use a glob to restrict file types.'
      : 'Find local files by glob, e.g. **/*.ts. The path is the search directory; Windows paths can use drive letters.',
    inputSchema: { type: 'object', additionalProperties: false, required: grep ? ['path', 'query'] : ['path', 'glob'],
      properties: { path: { type: 'string' }, glob: { type: 'string', description: 'Glob relative to the directory, with / separators' },
        ...(grep && { query: { type: 'string' }, caseSensitive: { type: 'boolean' }, context: { type: 'integer', minimum: 0, maximum: 3 } }) } },
  };
}

async function searchFiles(args, resolve, grep) {
  const { path: root, glob = '**/*', query, caseSensitive = false, context = 0 } = args || {};
  if (typeof root !== 'string' || typeof glob !== 'string' || !glob || glob.length > 256 || glob.includes('\\') ||
      (grep && (typeof query !== 'string' || !query || query.length > 300 || /[\r\n]/.test(query) ||
        typeof caseSensitive !== 'boolean' || !Number.isInteger(context) || context < 0 || context > 3))) throw Error('invalid_search');
  const directory = await resolve(root);
  if (directory.split(/[\\/]/).some((part) => excluded.has(part.toLowerCase()))) throw Error('search_directory_excluded');
  const isWindows = process.platform === 'win32';
  const matches = [];
  const deadline = Date.now() + 7000;
  let visited = 0;
  let scanned = 0;
  let truncated = false;
  let skippedLargeFiles = 0;
  let outputSize = 0;
  const needle = grep && new RegExp(RegExp.escape(query), caseSensitive ? 'u' : 'iu');
  const pattern = isWindows ? glob.toLowerCase() : glob;
  function add(match) {
    outputSize += Buffer.byteLength(encode(match));
    if (matches.length >= 100 || outputSize > 112 * 1024) { truncated = true; return; }
    matches.push(match);
  }
  async function walk(folder, relative = '') {
    for await (const entry of await fs.opendir(folder)) {
      if (++visited > 12000 || matches.length >= 100 || scanned >= 32 * 1024 * 1024 || Date.now() > deadline) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase()) || sensitive.test(entry.name)) continue;
      const candidate = path.join(folder, entry.name);
      const rel = relative + entry.name;
      if (entry.isDirectory()) {
        const resolved = await resolve(candidate).catch(() => null);
        if (resolved === candidate) await walk(resolved, rel + '/').catch(() => {});
        if (truncated) return;
        continue;
      }
      if (!entry.isFile() || !path.posix.matchesGlob(isWindows ? rel.toLowerCase() : rel, pattern)) continue;
      const file = await resolve(candidate).catch(() => null);
      if (file !== candidate) continue;
      if (!grep) { add({ path: rel }); if (truncated) return; continue; }
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        if (stat.size > 1024 * 1024) { skippedLargeFiles++; continue; }
        const bytes = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        scanned += bytesRead;
        const content = bytes.subarray(0, bytesRead);
        if (content.includes(0)) continue;
        const lines = content.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const column = lines[i].search(needle);
          if (column < 0) continue;
          const excerpt = lines[i].slice(Math.max(0, column - 80), Math.max(0, column - 80) + 240);
          add({ path: rel, line: i + 1, column: column + 1, text: excerpt,
            ...(context > 0 && { before: lines.slice(Math.max(0, i - context), i).map((line) => line.slice(0, 160)),
              after: lines.slice(i + 1, i + 1 + context).map((line) => line.slice(0, 160)) }) });
          if (truncated) return;
        }
      } catch {
        // A file can disappear or become unavailable during a scan.
      } finally { await handle?.close(); }
    }
  }
  await walk(directory);
  return { path: directory, matches, truncated, ...(grep && { skippedLargeFiles }) };
}

module.exports = { searchSpec, searchFiles };
