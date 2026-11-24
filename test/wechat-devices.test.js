const test = require('node:test');
const assert = require('node:assert/strict');
const { Devices, deviceList, changeText, statusText } = require('../orchestrator/wechat/devices');
const { parseCommand } = require('../orchestrator/wechat/router');

function fake(states) {
  const calls = [];
  const request = async (_socket, frame) => {
    calls.push(frame);
    const up = states[frame.bridge].shift();
    if (up === 'error') throw new Error('mcp_socket_closed');
    return { ssh: up, relay: false };
  };
  return { calls, request };
}

test('default device list is just the Mac', () => {
  assert.deepEqual(deviceList({}), [{ id: 'mac', label: 'Mac', bridge: 'mac', workspace: 'mac' }]);
});

test('first poll is a baseline; offline needs two misses, online is immediate', async () => {
  const { request, calls } = fake({ mac: [true, false, false, true] });
  let now = 0;
  const devices = new Devices({ config: {}, socket: 's', request, now: () => now });
  assert.deepEqual(await devices.poll(), []);
  assert.equal(calls[0].body.operation, 'route_status');
  now = 60_000; assert.deepEqual(await devices.poll(), []);           // 一次没查到不算离线
  now = 120_000; const down = await devices.poll();
  assert.equal(down.length, 1); assert.equal(down[0].online, false);
  now = 120_000 + 30 * 60_000; const up = await devices.poll();
  assert.equal(up[0].online, true);
  assert.match(changeText(up[0]), /Mac 已上线（离线了 30 分钟）/);
  assert.match(changeText(down[0]), /不用打开 AgentDesk/);
});

test('probe errors count as offline and status text lists every device', async () => {
  const { request } = fake({ mac: ['error'], lenovo: [true] });
  const devices = new Devices({ config: { devices: { mac: { label: 'Mac' }, lenovo: { label: '联想' } } }, socket: 's', request, now: () => 0 });
  await devices.poll();
  assert.equal(statusText(devices.snapshot(), 60_000), '【设备】\n🔴 Mac：离线（1 分钟）\n🟢 联想：在线（1 分钟）');
  assert.equal(devices.find('联想').bridge, 'lenovo');
  assert.equal(devices.find('').id, 'mac');
  assert.equal(devices.find('nope'), null);
});

test('admin device commands parse', () => {
  assert.deepEqual(parseCommand('/设备'), { kind: 'computer', choice: null });
  assert.deepEqual(parseCommand('/电脑'), { kind: 'computer', choice: null });
});
