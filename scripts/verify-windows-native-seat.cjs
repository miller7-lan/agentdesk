const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { Remote } = require('../remote');
const { createWorkerClient } = require('../orchestrator/windows-chat-worker');
const { openWindowsNativeSeat } = require('../orchestrator/windows-native-seat');

const provider = process.argv.includes('--claude') ? 'claude' : 'codex';
const useModel = process.argv.includes('--model');
const checkResume = process.argv.includes('--reconnect');
const remote = new Remote({ timing: { heartbeat: 240_000 } });
const limit = setTimeout(() => process.exit(2), 200_000);

remote.once('codex-ready', async () => {
  let windows;
  let vps;
  let worker;
  let child;
  let seat;
  const exec = async (command) => {
    const result = await remote.request('command/exec', { command, cwd: '/var/tmp', timeoutMs: 20_000,
      sandboxPolicy: { type: 'dangerFullAccess' } });
    if (result.exitCode !== 0) throw new Error('VPS fixture preparation failed: ' + (result.stderr || result.exitCode));
    return result.stdout.trim();
  };
  try {
    windows = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-native-seat-'));
    const project = path.join(windows, 'project');
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'hello.txt'), 'native-seat-fixture');
    if (useModel) {
      const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      await fs.access(compiler);
      await fs.writeFile(path.join(project, 'Program.cs'),
        'using System; class Demo { static void Main() { Console.WriteLine("OLD_SEAT_MARKER"); } }');
      await fs.writeFile(path.join(project, 'build.ps1'),
        `& '${compiler}' /nologo /out:NativeSeat.exe Program.cs\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\n& .\\NativeSeat.exe\nexit $LASTEXITCODE`);
    }
    vps = await exec(['mktemp', '-d', '/var/tmp/agentdesk-seat-code-XXXXXX']);
    if (!/^\/var\/tmp\/agentdesk-seat-code-[a-z0-9]+$/i.test(vps)) throw new Error('Unexpected fixture path');
    await exec(['chmod', '755', vps]);
    await exec(['/opt/agentdesk-orchestrator/node', '-e', `
      const fs=require('fs'),path=require('path'),dir='/opt/agentdesk-orchestrator';
      for(const name of fs.readdirSync(dir)) if(name.endsWith('.js')) fs.symlinkSync(path.join(dir,name),path.join(process.argv[1],name));
    `, vps]);
    for (const name of ['native-channel.js', 'native-project-session-host.js', 'project-mount.js', 'chat-server.js']) {
      const content = await fs.readFile(path.join(__dirname, '..', 'orchestrator', name));
      await exec(['/opt/agentdesk-orchestrator/node', '-e', `
        const fs=require('fs'); fs.rmSync(process.argv[1],{force:true});
        fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'),{mode:0o644});
      `, vps + '/' + name, content.toString('base64')]);
    }
    worker = createWorkerClient(path.join(windows, 'worker'), { launch(...args) { child = spawn(...args); return child; } });
    let connection = await worker.get();
    const identity = { device: 'fixture-device', provider, projectId: 'fixture-project', threadId: 'pending-' + randomUUID(),
      root: project, fullAccess: true };
    const binding = { ...identity, ...await connection.request('acquire', { binding: identity }) };
    const seatOptions = { remote, hostPath: vps + '/native-project-session-host.js',
      ...(checkResume && { sessionKey: randomBytes(32).toString('hex'), historyRoot: vps }) };
    let finishTurn;
    const completion = new Promise((resolve) => { finishTurn = resolve; });
    seat = await openWindowsNativeSeat({ ...seatOptions, worker: connection, identity, binding, onNotification: (frame) => {
        if (frame.method === 'turn/completed') finishTurn(frame.params.turn);
      } });
    const opened = await seat.request('thread/start');
    if (!opened?.thread?.id) throw new Error('Native provider did not return a thread');
    const bound = await connection.request('acquire', { binding: { ...identity, threadId: opened.thread.id } });
    if (bound.id !== binding.id) throw new Error('Official thread did not inherit the original project lease');
    console.log(provider + ' official thread and authenticated detached Worker successfully attached to the native seat');
    if (useModel) {
      await seat.request('turn/start', { threadId: opened.thread.id, input: [
        { type: 'text', text: 'This is a disposable Windows development fixture. Use your native file tools to read Program.cs and replace OLD_SEAT_MARKER with VERIFIED_NATIVE_SEAT. Invoke local_shell with action run and PowerShell command "& .\\build.ps1". Verify that the Windows EXE prints VERIFIED_NATIVE_SEAT.', text_elements: [] },
      ] });
      const done = await completion;
      if (done.status !== 'completed') throw new Error('Model turn did not complete: ' + (done.error?.message || done.status));
      const exe = await fs.readFile(path.join(project, 'NativeSeat.exe'));
      const source = await fs.readFile(path.join(project, 'Program.cs'), 'utf8');
      const results = await connection.request('shell', { binding: { ...identity, ...bound, threadId: opened.thread.id }, args: { action: 'list' } });
      if (!source.includes('VERIFIED_NATIVE_SEAT') || exe.subarray(0, 2).toString() !== 'MZ' ||
          !results.runs.some((entry) => entry.exitCode === 0 && entry.stdout.includes('VERIFIED_NATIVE_SEAT'))) {
        throw new Error('The native seat did not prove the Windows build');
      }
      console.log(provider + ' edited the Windows file and built and ran the EXE through the production Worker path');
    }
    if (checkResume) {
      const actual = { ...identity, ...bound, threadId: opened.thread.id };
      const launched = await connection.request('shell', { binding: actual, requestId: 'recovery-command',
        args: { action: 'run', background: true, command: 'Start-Sleep -Seconds 2; Write-Output RECOVERY_OK' } });
      await seat.close();
      seat = null;
      worker.disconnect();
      connection = await worker.get();
      let outcome;
      for (let attempt = 0; attempt < 40; attempt++) {
        outcome = await connection.request('shell', { binding: actual, args: { action: 'status', runId: launched.runId } });
        if (outcome.finishedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (outcome.runId !== launched.runId || outcome.exitCode !== 0 || !outcome.stdout.includes('RECOVERY_OK')) {
        throw new Error('Original persistent Windows command was not recovered');
      }
      const recovered = await connection.request('reconcile', { binding: actual });
      if (!recovered && (!useModel || !await connection.request('acknowledge', { binding: actual }))) {
        throw new Error('The reconciled fixture could not recover its lease');
      }
      const current = await connection.request('acquire', { binding: actual });
      if (current.id !== actual.id || current.generation <= actual.generation) throw new Error('Native lease did not advance its generation');
      seat = await openWindowsNativeSeat({ ...seatOptions, worker: connection, identity: actual, binding: { ...actual, ...current } });
      const resumed = await seat.request('thread/resume', { threadId: actual.threadId });
      if (resumed?.thread?.id !== actual.threadId) throw new Error('Official thread identity did not survive reconnect');
      console.log(provider + ' recovered the original thread and command run with a new SFTP generation');
    }
    await seat.close({ confirmedIdle: true });
    seat = null;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await seat?.close().catch(() => {});
    worker?.disconnect();
    child?.kill();
    if (vps && /^\/var\/tmp\/agentdesk-seat-code-[a-z0-9]+$/i.test(vps)) {
      await exec(['rm', '-rf', '--', vps]).catch(() => { process.exitCode = 1; });
    }
    if (windows) await fs.rm(windows, { recursive: true, force: true }).catch(() => { process.exitCode = 1; });
    clearTimeout(limit);
    await remote.stop();
  }
});
remote.startCodex();
