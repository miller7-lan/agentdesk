// Group chat v7 capabilities, each with its own switch in config.json:
//   "groupFeatures": { "timeline": true, "anyLead": true, ... }
// A capability is on only when its switch is true; a missing switch means off, so an old config keeps the old
// behaviour and any single capability can be turned off again (then restart the orchestrator) to roll it back.
const FEATURES = {
  timeline: '群聊消息按时间排序，分工进度随变化移到最新位置（Q5）',
  snapshotNotice: '项目上传云端成功提示（要求 7）',
  planFailureAdvice: '规划失败时给出可行的单聊尝试（要求 4）',
  anyLead: '组长（规划、诊断、验收）可任选成员和模型（Q1）',
  leadChainQuota: '组长链成员超过软线只做组长的活（N3）',
  patchDownload: '补丁下载到本机、校验并提示成功（Q4、要求 7）',
  applyPause: '应用补丁期间暂缓启动新的本机命令（O2）',
  // Second tranche (v7 G-P1 … G-P2d). The Bridge-side parts need an updated Bridge on the computer; an older
  // Bridge answers bridge_update_required and the group carries on as before.
  stageGroups: '只读阶段并行（全机 6 个、每台设备 4 个），改写阶段每个项目单线程；并行出错后该任务改为串行（G-P1）',
  localStages: '读取、审批/审查、诊断、验收在本机原项目读文件和运行任意命令（M1、O1、Q3、M4）',
  writeAnywhere: '改写阶段可写本机任意位置（凭据目录、.git 内部、AgentDesk 密钥目录除外），不再确认（Q2、N2）',
  localCopy: '改写阶段需要本机工具链时在本机副本中运行命令；Mac 上 sandbox 禁写原项目，Windows 只检测并标注（M3、O3）',
  credentialSandbox: 'Mac 上群聊本机命令用 sandbox 挡凭据目录和 AgentDesk 密钥目录，.git 内部不挡；Windows 不强制（M2）',
  envFix: '测试、验证、诊断、审查、验收可直接打本机环境修复补丁，带备份、写令牌、O2 排队、回传云端（P1、R1–R3、E1–E12）',
  leadAdvice: '规划失败时由组长链中下一位可用成员总结单聊建议，失败时退回规则建议（要求 4）',
};

function groupFeatures(value) {
  if (value === undefined || value === null) return Object.fromEntries(Object.keys(FEATURES).map((name) => [name, false]));
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_group_features');
  for (const [name, on] of Object.entries(value)) {
    if (!Object.hasOwn(FEATURES, name) || typeof on !== 'boolean') throw new Error('invalid_group_features:' + name);
  }
  return Object.fromEntries(Object.keys(FEATURES).map((name) => [name, value[name] === true]));
}

module.exports = { groupFeatures, FEATURES };
