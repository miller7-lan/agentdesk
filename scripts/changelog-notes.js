'use strict';
// Prints the CHANGELOG.md section for one version (without its heading), for the release upload's --notes and for
// the app's update dialog. Exits 1 when the version has no section, so a release cannot go out without one.

const fs = require('fs');
const path = require('path');

const LIMIT = 2000;

function changelogNotes(text, version) {
  const lines = String(text || '').split(/\r?\n/);
  const heading = (line) => /^##\s+/.test(line);
  const start = lines.findIndex((line) => heading(line) && line.replace(/^##\s+/, '').split(/[\s（(]/)[0] === version);
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && heading(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body ? body.slice(0, LIMIT) : null;
}

if (require.main === module) {
  const version = process.argv[2];
  const file = process.argv[3] || path.join(__dirname, '..', 'CHANGELOG.md');
  const notes = changelogNotes(fs.readFileSync(file, 'utf8'), version);
  if (!notes) { console.error(`CHANGELOG.md 里没有 ${version} 这一节`); process.exit(1); }
  process.stdout.write(notes);
}

module.exports = { changelogNotes, LIMIT };
