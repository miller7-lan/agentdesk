# Win32-OpenSSH sftp-server (bundled with the Windows build)

From Microsoft's PowerShell/Win32-OpenSSH release `10.0.0.0p2-Preview`, `OpenSSH-Win64.zip`
(sha256 `23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5`), unchanged:
`sftp-server.exe`, `libcrypto.dll`, `LICENSE.txt`.

Used by native CLI single chats (orchestrator/native-cli-ssh.js) to serve this computer's files to the CLI on VPS2
(`mount computer` in orchestrator/agentdesk-cli.js), running as the signed-in person: Windows decides what it may
read or write. Most Windows computers have only the OpenSSH client, without sftp-server, so it ships with AgentDesk.
macOS uses its own /usr/libexec/sftp-server.
