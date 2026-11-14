const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = path.join(root, 'node_modules', 'agent-desktop');
const name = 'agent-desktop-win32-x64.exe';
const binary = fs.readFileSync(path.join(pkg, 'bin', name));
const digest = createHash('sha256').update(binary).digest('hex');
assert.equal(digest, 'a7ef5e539fb97287a35eb9ed49d3803b4d6bd705bc4106eb28617229f9be679e',
  'Unexpected agent-desktop 1.3.1 Windows x64 binary');
const destination = path.join(root, 'desktop-backend');
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, name), binary);
for (const name of ['LICENSE', 'NOTICE']) {
  const source = path.join(pkg, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, name));
}
