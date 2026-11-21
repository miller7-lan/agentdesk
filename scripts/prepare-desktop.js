const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = path.join(root, 'node_modules', 'agent-desktop');
const mac = process.argv.includes('--mac') || (!process.argv.includes('--win') && process.platform === 'darwin');
const architecture = process.arch;
const destination = path.join(root, 'desktop-backend');
fs.mkdirSync(destination, { recursive: true });

function copyBinary(name, target, digest) {
  const binary = fs.readFileSync(path.join(pkg, 'bin', name));
  assert.equal(createHash('sha256').update(binary).digest('hex'), digest, 'Unexpected agent-desktop binary: ' + name);
  fs.writeFileSync(path.join(destination, target), binary, { mode: 0o755 });
  fs.chmodSync(path.join(destination, target), 0o755);
}

if (mac) {
  const main = 'agent-desktop-darwin-' + architecture;
  const helper = 'agent-desktop-macos-helper-darwin-' + architecture;
  for (const [name, target] of [[main, main], [helper, 'agent-desktop-macos-helper']]) {
    const checksum = fs.readFileSync(path.join(pkg, 'bin', name + '.sha256'), 'utf8').trim();
    copyBinary(name, target, checksum);
  }
} else {
  const name = 'agent-desktop-win32-x64.exe';
  copyBinary(name, name, 'a7ef5e539fb97287a35eb9ed49d3803b4d6bd705bc4106eb28617229f9be679e');
}
for (const name of ['LICENSE', 'NOTICE']) {
  const source = path.join(pkg, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, name));
}

// The terminal view (src/vendor/xterm) must be the same xterm.js release the lockfile installs.
for (const [file, pkgName, source] of [['xterm.js', '@xterm/xterm', 'lib/xterm.js'], ['addon-fit.js', '@xterm/addon-fit', 'lib/addon-fit.js'],
  ['xterm.css', '@xterm/xterm', 'css/xterm.css']]) {
  const installed = path.join(root, 'node_modules', pkgName, source);
  if (!fs.existsSync(installed)) continue;
  const strip = (text) => text.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n').replace(/\s+$/, '');
  const vendored = fs.readFileSync(path.join(root, 'src', 'vendor', 'xterm', file), 'utf8');
  assert.equal(strip(vendored), strip(fs.readFileSync(installed, 'utf8')), `src/vendor/xterm/${file} differs from ${pkgName}`);
}
