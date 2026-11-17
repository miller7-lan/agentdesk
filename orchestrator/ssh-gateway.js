const { connect } = require('node:net');

// This entry point is an SSH forced command. It never reads SSH_ORIGINAL_COMMAND.
const socket = connect(process.argv[2]);
socket.once('connect', () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('error', () => {
  process.stderr.write('AgentDesk bridge socket unavailable\n');
  process.exitCode = 1;
  process.stdin.destroy();
});
socket.on('close', () => process.stdin.destroy());
