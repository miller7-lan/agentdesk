// Every script CI runs must at least parse. scripts/packaged-terminal-smoke.js once shipped with its failure
// handler folded into a comment (a syntax error), so the packaged-app terminal check on macOS failed before it
// tested anything and the run showed only "exit code 1".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('every script under scripts/ parses', () => {
  const folder = path.join(__dirname, '..', 'scripts');
  const files = fs.readdirSync(folder).filter((name) => /\.(c?js|mjs)$/.test(name));
  assert.ok(files.includes('packaged-terminal-smoke.js'));
  for (const name of files) {
    try { execFileSync(process.execPath, ['--check', path.join(folder, name)], { stdio: 'pipe' }); }
    catch (error) { assert.fail(name + ' does not parse: ' + String(error.stderr || error.message).slice(0, 400)); }
  }
});
