const { connect } = require('node:net');

// This entry point is an SSH forced command: argv[2] is the Bridge's protocol socket. The one thing the client
// may choose is the read-only home mount: when the authorized_keys line also names a mount socket (argv[3])
// and the client asked for exactly "agentdesk-mount", the session goes to that socket instead. Any other
// requested command is ignored and the session goes to the protocol socket, as before.
const mount = process.argv[3] && process.env.SSH_ORIGINAL_COMMAND === 'agentdesk-mount';
const socket = connect(mount ? process.argv[3] : process.argv[2]);
socket.once('connect', () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('error', () => {
  process.stderr.write(mount ? 'AgentDesk mount socket unavailable\n' : 'AgentDesk bridge socket unavailable\n');
  process.exitCode = 1;
  process.stdin.destroy();
});
socket.on('close', () => process.stdin.destroy());
