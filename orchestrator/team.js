function teamAdapter(docker, stateDir, create) {
  if (!docker?.enabled || !docker.teamCommand) return null;
  const command = Array.isArray(docker.teamCommand) ? docker.teamCommand : [docker.teamCommand];
  const [program, ...args] = command;
  if (typeof program !== 'string' || !/^\/[a-z0-9/_.-]+$/i.test(program) ||
      args.length > 32 || args.some((arg) => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0'))) {
    throw new Error('invalid_team_command');
  }
  let factory = create;
  if (!factory) {
    // Docker ships separately. Until that runtime is present, keep the approved multi-step plan.
    let filename;
    try { filename = require.resolve('./docker'); } catch { return null; }
    factory = require(filename).createDockerAdapter;
  }
  const adapter = factory({ ...docker, commands: { ...docker.commands, codex: program } }, { stateDir });
  return (options) => adapter({
    ...options,
    config: {
      ...options.config,
      template: { args, prompt: 'stdin', output: 'plain', session: 'none' },
    },
    mcp: undefined,
  });
}

module.exports = { teamAdapter };
