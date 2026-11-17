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
  // The enrollment port is open to the internet, so the password is the one thing between a scanner and an
  // SSH certificate. Rate limits slow guessing; length is what makes it hopeless.
  if (password.length < 16) throw new Error('password_too_short:use_at_least_16_characters');
  const salt = randomBytes(32);
  const hash = scryptSync(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
  const staged = destination + '.' + randomBytes(6).toString('hex');
  fs.writeFileSync(staged, JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex') }) + '\n', {
    flag: 'wx', mode: 0o600,
  });
  fs.renameSync(staged, destination);
});
