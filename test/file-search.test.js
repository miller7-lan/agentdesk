const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { searchFiles } = require('../orchestrator/file-search');

test('local glob and literal grep return relative paths, lines and context, skipping excluded files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-file-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = await fs.realpath(root);
  for (const subdir of ['src', '.git', 'node_modules']) {
    await fs.mkdir(path.join(directory, subdir));
    await fs.writeFile(path.join(directory, subdir, 'index.ts'), 'before\r\n// Marker.\r\nafter');
  }
  await fs.writeFile(path.join(directory, 'src', 'binary.ts'), Buffer.from('marker.\0'));
  await fs.writeFile(path.join(directory, 'src', '.env.test'), 'marker. secret');
  const args = { path: directory, glob: '**/*.ts', query: 'marker.', context: 1 };
  const glob = await searchFiles(args, fs.realpath, false);
  assert.deepEqual(glob.matches.map(({ path }) => path).sort(), ['src/binary.ts', 'src/index.ts']);
  const grep = await searchFiles(args, fs.realpath, true);
  assert.deepEqual(grep.matches, [{ path: 'src/index.ts', line: 2, column: 4, text: '// Marker.', before: ['before'], after: ['after'] }]);
  assert.equal(grep.truncated, false);
  assert.deepEqual((await searchFiles({ ...args, caseSensitive: true }, fs.realpath, true)).matches, []);
});
