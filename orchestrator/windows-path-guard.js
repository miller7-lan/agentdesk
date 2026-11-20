const path = require('node:path').win32;
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

// Node's Windows file API follows junctions on open. Hold handles to the real directory
// chain without FILE_SHARE_DELETE while a pathname operation is in flight. Inspect the
// reparse attribute on the handle itself, before opening anything below it.
const program = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ProjectPathGuard {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool MoveFileEx(string source, string target, uint flags);

  public static void Move(string source, string target, bool replace) {
    if (!MoveFileEx(source, target, replace ? 9U : 8U)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }

  public static SafeFileHandle Pin(string path, bool directory, bool optional) {
    var handle = CreateFile(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      if (optional && error == 2) return null;
      throw new Win32Exception(error);
    }
    try {
      FileInformation information;
      if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if ((information.Attributes & 0x400) != 0 || ((information.Attributes & 0x10) != 0) != directory ||
          (!directory && information.Links != 1)) throw new UnauthorizedAccessException();
      return handle;
    } catch { handle.Dispose(); throw; }
  }
}
'@
$held = @()
[Console]::WriteLine('ready')
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = ConvertFrom-Json $line
      if ($request.release) {
        foreach ($handle in $held) { $handle.Dispose() }
        $held = @()
        [Console]::WriteLine('ok')
        continue
      }
      if ($request.move) {
        [ProjectPathGuard]::Move($request.move.source, $request.move.target, $request.move.replace)
        [Console]::WriteLine('ok')
        continue
      }
      $missing = $false
      foreach ($entry in $request.entries) {
        $handle = [ProjectPathGuard]::Pin($entry.path, $entry.directory, $entry.optional)
        if ($null -eq $handle) { $missing = $true } else { $held += $handle }
      }
      if ($missing) { [Console]::WriteLine('missing') } else { [Console]::WriteLine('ok') }
    } catch {
      foreach ($handle in $held) { $handle.Dispose() }
      $held = @()
      $errorType = $_.Exception.GetBaseException()
      if ($errorType -is [ComponentModel.Win32Exception] -and $errorType.NativeErrorCode -in 2,3) {
        [Console]::WriteLine('not_found')
      } else {
        [Console]::WriteLine('denied')
      }
    }
  }
} finally {
  foreach ($handle in $held) { $handle.Dispose() }
}
`;

function startGuard() {
  if (process.platform !== 'win32') throw new Error('project_sftp_windows_required');
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(program, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stopped = false;
  child.on('error', () => { stopped = true; });
  child.stdin.on('error', () => { stopped = true; });
  child.once('exit', () => { stopped = true; });
  const receive = async () => {
    const { value } = await lines.next();
    if (stopped || !value) throw new Error('project_path_guard_stopped');
    return value;
  };
  const ready = receive();
  ready.catch(() => {});
  const call = async (request) => {
    if (await ready !== 'ready' || stopped) throw new Error('project_path_guard_stopped');
    child.stdin.write(JSON.stringify(request) + '\n');
    const reply = await receive();
    if (reply === 'not_found') throw Object.assign(new Error('project_path_not_found'), { code: 'ENOENT' });
    if (reply !== 'ok' && reply !== 'missing') throw Object.assign(new Error('project_path_denied'), { code: 'EACCES' });
    return reply === 'ok';
  };
  return {
    move: (source, target, replace) => call({ move: { source, target, replace } }),
    async withPaths(directories, leaf, action) {
      const entries = new Map();
      for (let folder of directories) {
        const drive = path.parse(folder).root;
        while (folder !== drive) {
          entries.set(folder.toLowerCase(), { path: folder, directory: true, optional: false });
          folder = path.dirname(folder);
        }
      }
      const ordered = [...entries.values()].sort((a, b) => a.path.length - b.path.length);
      if (leaf) ordered.push(leaf);
      const exists = await call({ entries: ordered });
      try { return await action(exists); } finally { await call({ release: true }); }
    },
    close() {
      child.stdin.end();
    },
  };
}

module.exports = { startGuard };
