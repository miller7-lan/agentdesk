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
