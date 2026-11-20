const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { Lines } = require('../orchestrator/transport');
const { localShellSpec } = require('../orchestrator/windows-local-shell');

async function verifyProvider({ remote, namespacePid, folder, directory, protocol, binding, provider = 'codex', claudeEntry, claudeState, sandboxOnly, traceFile, account }) {
  const display = provider === 'codex' ? 'Codex' : 'Claude';
  const marker = 'VERIFIED_NATIVE_' + provider.toUpperCase();
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await fs.access(compiler);
  await fs.writeFile(path.join(directory, 'Program.cs'),
    'using System; class Demo { static void Main() { Console.WriteLine("OLD_MARKER"); } }');
  await fs.writeFile(path.join(directory, 'build.ps1'), [
    '$ErrorActionPreference = "Stop"',
    '& ' + "'" + compiler.replace(/'/g, "''") + "'" + ' /nologo /out:NativeChatDemo.exe Program.cs',
    'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
    '& .\\NativeChatDemo.exe',
    'exit $LASTEXITCODE',
  ].join('\n'));
  const processId = randomUUID();
  const input = new PassThrough();
  const output = new PassThrough();
  const wire = new Lines(input, output, 4 * 1024 * 1024);
  const pending = new Map();
  const toolResults = [];
  let next = 0;
  let threadId;
  let turnId;
  let resolveTurn;
  let rejectTurn;
  let diagnostics = '';
  const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  completed.catch(() => {});
  const disconnected = (error) => {
    for (const finish of pending.values()) finish.reject(error);
    pending.clear();
    rejectTurn(error);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    wire.send({ id, method, params });
  });
  const notify = ({ method, params }) => {
    if (method !== 'command/exec/outputDelta' || params?.processId !== processId) return;
    if (params.capReached) disconnected(new Error('Native Codex fixture output was truncated'));
    else if (params.stream === 'stdout') input.write(Buffer.from(params.deltaBase64, 'base64'));
    else diagnostics = (diagnostics + Buffer.from(params.deltaBase64, 'base64').toString()).slice(-500);
  };
  remote.on('notification', notify);
  let sent = Promise.resolve();
  output.on('data', (bytes) => {
    sent = sent.then(() => remote.request('command/exec/write', { processId, deltaBase64: bytes.toString('base64') }));
    sent.catch(disconnected);
  });
  wire.on('fault', disconnected);
  wire.on('frame', (frame) => {
    if (frame.method === 'turn/started' && frame.params?.threadId === threadId) turnId = frame.params.turn.id;
    if (frame.method === 'turn/completed' && frame.params?.threadId === threadId) resolveTurn(frame.params.turn);
    if (frame.method && frame.id !== undefined) {
      const params = frame.params;
      Promise.resolve().then(async () => {
        if (frame.method !== 'item/tool/call' || params.tool !== 'local_shell' ||
            params.threadId !== threadId || params.turnId !== turnId) throw new Error('Fixture rejected unrelated tool call');
        const response = await protocol({
          protocolVersion: 1, operation: 'local_shell.' + params.arguments.action,
          requestId: 'fixture-' + String(params.itemId || frame.id), leaseId: binding.id,
          generation: binding.generation, args: params.arguments,
        });
        if (!response.ok) throw new Error(response.error.code);
        const result = response.value;
        toolResults.push(result);
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
      }).then((result) => wire.send({ id: frame.id, result }), (error) =>
        wire.send({ id: frame.id, result: { success: false, contentItems: [{ type: 'inputText', text: error.message }] } }));
      return;
    }
    const finish = pending.get(frame.id);
    if (!finish) return;
    pending.delete(frame.id);
    if (frame.error) finish.reject(new Error(frame.error.message));
    else finish.resolve(frame.result);
  });
  const argv = provider === 'codex' ? [
    ...(traceFile ? ['strace', '-f', '-tt', '-e', 'trace=%process,mount,umount2,unshare,setns,statfs', '-o', traceFile] : []),
    'codex', 'app-server',
  ] :
    ['setpriv', '--reuid', String(account.uid), '--regid', String(account.gid), '--clear-groups',
      'env', 'AGENTDESK_CHAT_STATE=' + claudeState,
      'AGENTDESK_CHAT_HOME_CLAUDE=/var/lib/agentdesk-orchestrator/homes/claude',
      'AGENTDESK_CHAT_SANDBOX=/usr/bin/bwrap', 'AGENTDESK_CLAUDE_NATIVE_PROJECT=' + folder,
      '/opt/agentdesk-orchestrator/node', claudeEntry, 'claude'];
  const server = remote.request('command/exec', {
    command: ['nsenter', '--mount', '--target', namespacePid, '--', '/bin/bash', '-c',
      'cd -- "$1"; shift; exec "$@"', 'fixture', provider === 'codex' ? '/var/tmp' : folder, ...argv], cwd: '/tmp', timeoutMs: 150_000,
    streamStdin: true, streamStdoutStderr: true, disableOutputCap: true, processId, sandboxPolicy: { type: 'dangerFullAccess' },
  }, { timeoutMs: 155_000 });
  server.then(({ exitCode }) => disconnected(new Error('Native Codex fixture process exited ' + exitCode + ' ' + diagnostics)), disconnected);
  // Wait for the outer app-server to register the process before sending stdin.
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    await request('initialize', { clientInfo: { name: 'agentdesk-native-fixture', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    console.log(display + ' fixture initialized');
    wire.send({ method: 'initialized', params: {} });
    const opened = await request('thread/start', { cwd: folder, approvalPolicy: 'never', sandbox: 'workspace-write', dynamicTools: [localShellSpec] });
    threadId = opened.thread.id;
    console.log(display + ' fixture thread opened in the mounted workspace');
    if (sandboxOnly) {
      const write = { type: 'workspaceWrite', writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false };
      for (const [label, cwd, policy] of [
        ['ordinary cwd / workspace-write', '/var/tmp', write],
        ['SSHFS cwd / diagnostic full access', folder, { type: 'dangerFullAccess' }],
        ['SSHFS cwd / workspace-write', folder, { ...write, writableRoots: [folder] }],
      ]) {
        const mounted = cwd === folder;
        const started = Date.now();
        const value = await request('command/exec', {
          cwd, command: mounted ? ['python3', '-u', '-c',
            'from pathlib import Path; print("started"); p=Path("Program.cs"); text=p.read_text(); print("read"); p.write_text(text + "\\n// probe\\n"); print("wrote")']
            : ['/bin/echo', 'ordinary sandbox ready'],
          timeoutMs: mounted && policy.type === 'workspaceWrite' ? 75_000 : 25_000, sandboxPolicy: policy,
        });
        console.log(label + ': ' + JSON.stringify({ ms: Date.now() - started, code: value.exitCode, stdout: value.stdout, stderr: value.stderr }));
        if (value.exitCode !== 0) throw new Error('Failed layer: ' + label);
      }
      if (!(await fs.readFile(path.join(directory, 'Program.cs'), 'utf8')).includes('// probe')) throw new Error('Windows probe write not visible');
      return;
    }
    await request('turn/start', {
      threadId, cwd: folder,
      ...(provider === 'codex' && { sandboxPolicy: { type: 'workspaceWrite', writableRoots: [folder], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true } }),
      input: [{ type: 'text', text: `This is a disposable local Windows development fixture. Read Program.cs using your native file tools, then edit OLD_MARKER to ${marker} using your native edit tool. Use local_shell with action run and PowerShell command "& .\\build.ps1" to compile and run the Windows EXE. The project files are mounted from Windows. Run the actual build through local_shell. Report the result.`, text_elements: [] }],
    });
    const turn = await completed;
    if (turn.status !== 'completed') throw new Error(display + ' fixture turn: ' + turn.status + (turn.error?.message ? ' ' + turn.error.message : ''));
    const contents = await fs.readFile(path.join(directory, 'Program.cs'), 'utf8');
    const exe = await fs.readFile(path.join(directory, 'NativeChatDemo.exe'));
    if (!contents.includes(marker) || exe.subarray(0, 2).toString() !== 'MZ' ||
        !toolResults.some((result) => result.exitCode === 0 && result.stdout.includes(marker))) {
      throw new Error('The ' + display + ' fixture did not prove both the file edit and the Windows build');
    }
    console.log(display + ' edited the mounted Windows file and built and ran a Windows EXE through local_shell');
  } finally {
    await remote.request('command/exec/terminate', { processId }).catch(() => {});
    await server.catch(() => {});
    remote.off('notification', notify);
    input.destroy();
    output.destroy();
  }
}

module.exports = { verifyProvider };
