const { readFile } = require('node:fs/promises');
const os = require('node:os');

async function hostResources() {
  const fields = {};
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    for (const match of text.matchAll(/^(MemTotal|MemAvailable|MemFree|SwapTotal|SwapFree):\s+([0-9]+) kB$/gm)) {
      fields[match[1]] = Number(match[2]) * 1024;
    }
  } catch { /* 其他系统使用 Node 提供的宿主内存。 */ }

  const memoryTotalBytes = fields.MemTotal ?? os.totalmem();
  const available = fields.MemAvailable ?? fields.MemFree ?? os.freemem();
  const swapTotalBytes = fields.SwapTotal ?? 0;
  return {
    host: {
      memoryTotalBytes,
      memoryUsedBytes: Math.max(0, memoryTotalBytes - available),
      swapTotalBytes,
      swapUsedBytes: Math.max(0, swapTotalBytes - (fields.SwapFree ?? 0)),
    },
    docker: { enabled: false, ok: false },
  };
}

module.exports = { hostResources };
