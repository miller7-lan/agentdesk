'use strict';
// The safe-restart gate. Every probe reads state the main process owns (or asks VPS2 / the local Worker itself);
// nothing the window reports counts. A probe answers idle, busy (with reasons) or unknown; the gate opens only when
// every probe says idle. A probe that throws, times out or answers anything else counts as unknown, and unknown
// blocks the installation — there is no override. Nothing here stops, cancels or disconnects anything.

const PROBE_TIMEOUT = 5000;

function normalize(name, value) {
  if (!value || typeof value !== 'object' || !['idle', 'busy', 'unknown'].includes(value.state)) {
    return { name, state: 'unknown', reasons: ['无法确认：' + name] };
  }
  const reasons = Array.isArray(value.reasons) ? value.reasons.filter((item) => typeof item === 'string').slice(0, 12) : [];
  if (value.state !== 'idle' && !reasons.length) reasons.push((value.state === 'busy' ? '仍在运行：' : '无法确认：') + name);
  return { name, state: value.state, reasons, ...(value.detail && { detail: value.detail }) };
}

function withTimeout(promise, ms, timers) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = timers.setTimeout(() => resolve({ state: 'unknown', reasons: ['检查超时'] }), ms); }),
  ]).finally(() => timers.clearTimeout(timer));
}

function createUpdateGate({ timeout = PROBE_TIMEOUT, timers = globalThis } = {}) {
  const probes = new Map();
  let locked = false;
  return {
    register(name, probe) {
      if (typeof probe !== 'function') throw new Error('invalid_probe');
      probes.set(name, probe);
    },
    get locked() { return locked; },
    lock() { locked = true; },
    unlock() { locked = false; },
    async evaluate() {
      if (!probes.size) return { state: 'unknown', reasons: ['没有可用的任务检查'], probes: [] };
      const results = await Promise.all([...probes].map(async ([name, probe]) => {
        try { return normalize(name, await withTimeout(Promise.resolve().then(probe), timeout, timers)); } catch {
          return { name, state: 'unknown', reasons: ['无法确认：' + name] };
        }
      }));
      const state = results.some((item) => item.state === 'unknown') ? 'unknown'
        : results.some((item) => item.state === 'busy') ? 'busy' : 'idle';
      const reasons = results.filter((item) => item.state !== 'idle').flatMap((item) => item.reasons);
      return { state, reasons, probes: results };
    },
  };
}

// Helpers for the probes main.js registers.
const idle = () => ({ state: 'idle', reasons: [] });
const busy = (...reasons) => ({ state: 'busy', reasons });
const unknown = (...reasons) => ({ state: 'unknown', reasons });
function countProbe(count, reason) {
  return () => {
    const value = count();
    if (!Number.isSafeInteger(value) || value < 0) return unknown(reason);
    return value ? busy(reason + (value > 1 ? `（${value} 项）` : '')) : idle();
  };
}

// Group tasks on VPS2 that are not finished (planning, running, testing, applying, waiting for approval…).
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'needs_review']);
function groupTasksProbe(request) {
  return async () => {
    const reply = await request();
    if (!reply) return idle(); // this installation has no group orchestration at all
    if (!reply.ok || !Array.isArray(reply.value)) return unknown('无法向主控确认群聊任务状态');
    const open = reply.value.filter((task) => task && !TERMINAL_TASK_STATES.has(task.state));
    if (reply.value.some((task) => !task || typeof task.state !== 'string')) return unknown('群聊任务状态格式无法识别');
    return open.length ? busy(`群聊仍有 ${open.length} 个任务未结束（规划、执行、测试、补丁应用或等待审批）`) : idle();
  };
}

module.exports = { createUpdateGate, countProbe, groupTasksProbe, idle, busy, unknown, TERMINAL_TASK_STATES, PROBE_TIMEOUT };
