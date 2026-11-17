const { createInterface } = require('node:readline');
const { randomBytes, scryptSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error('verifier_path_required');
const reader = createInterface({ input: process.stdin });
reader.once('line', (password) => {
  reader.close();
  if (!password || password.length > 256) throw new Error('invalid_password');
  const salt = randomBytes(32);
  const hash = scryptSync(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
  const staged = destination + '.' + randomBytes(6).toString('hex');
  fs.writeFileSync(staged, JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex') }) + '\n', {
    flag: 'wx', mode: 0o600,
  });
  fs.renameSync(staged, destination);
});
