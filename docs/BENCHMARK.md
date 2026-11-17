# 10 个真实任务：单干 vs 多 agent 对照

目标是用同一批任务比较「一个人直接做」和「AgentDesk 多 agent 流程」，看成功率、返工、耗时、额度和 token 消耗。不要挑简单任务，也不要在看到结果后换任务。

## 1. 准备

1. 选 10 个真实、范围相近、能独立验收的任务。每个任务写清验收条件和测试命令。
2. 每个任务准备一个 benchmark 编号，例如 `bench-2026-11`；两组的编号必须相同。
3. 单干组由一个人在一个工作区完成并记录起止时间；多 agent 组通过 AgentDesk 提交。
4. 两组使用相同的仓库基线、相同测试命令和相同验收人。单干组不要使用 AgentDesk 的规划、审查或验收步骤。

## 2. 单干组

逐个记录：

- 开始 / 结束时间
- 测试通过或失败
- 返工次数（测试失败后重新修改算一次）
- 所用 CLI 及其真实额度百分比变化；无法读取额度时记录 token 用量并注明
- 是否被验收人接受

## 3. 多 agent 组

每个任务提交一次，带上同一个 `benchmarkId` 和 `arm=single` / `arm=multi`。单干组手工记录后，也可以通过 `--arm single` 提交一个只读占位任务，把人工记录填进同名任务，便于统一报表；如果不这样做，`report` 里单干组只看人工表格。

```bash
# 在 VPS2 上，ad 是 OPERATIONS.md 里的管理命令封装
ad submit mac '给播放器加暂停按钮；验收：npm test 通过' 'npm test' \
  --tag ui --project agentdesk --benchmark-id bench-2026 --arm multi

ad report --project agentdesk --since 2026-11-17T00:00:00Z --format table
ad benchmark bench-2026 --format table
```

`ad` 的 `submit` 返回任务 ID，用它跟踪状态：

```bash
ad status <task-id>
```

多 agent 组不需要人工统计返工：任务记录里有 `testFailures`、`reviewConflicts`、`reworkRounds`、`triageRounds`；验收结论在 `acceptance`。任务完成后 `metrics` 会自动写入起止时间、耗时、各 CLI 调用次数、改派次数、token 和额度。不要为了跑分打开 `acceptance.mode=off`：那会绕过验收，结果不可比。

## 4. 对照字段

| 字段 | 含义 |
|---|---|
| `count` | 任务数 |
| `accepted` / `successRate` | 已完成或 Claude 验收通过的任务数 / 占比；等待人工 apply 但已验收的补丁也算通过 |
| `firstPass` / `firstPassRate` | 没有测试失败、审查冲突、返工或升级就通过的任务 |
| `durationMs` | 从首次实际执行（规划或运行）到最后终止状态；`needs_review` 后继续 apply 会重新计算 |
| `reworkRounds` / `tasksReworked` | 返工轮数 / 发生返工的任务数 |
| `triageRounds` / `tasksTriaged` | Claude 升级诊断轮数 / 任务数 |
| `testFailures` / `reviewConflicts` | 连续测试失败计数 / 审查意见冲突次数 |
| `roleCalls` | 每个 CLI 的调用次数（含重试） |
| `reassignments` | 因额度或登录问题改派的次数 |
| `tokens` | 输入、输出、缓存读 / 写、推理 token 汇总；`total` 是各类之和 |
| `usage` | 每个 CLI 的原始 usage 字段之和 |
| `quota` | 每个 CLI 五小时 / 每周窗口被任务消耗的百分点之和 |

`benchmark <id>` 固定输出 `single` 和 `multi` 两组，并在 `compare` 中给出成功率差、首轮通过率差、平均耗时差、返工差和 token 差。没有任务的分组也会保留零值，避免把「没跑到」误读成「更好」。

## 5. 结果记录

把两次 `ad benchmark bench-2026 --format csv` 的输出和单干组人工表一起存档。结论至少回答：

1. 多 agent 组的成功率和首轮通过率是否更高，高多少？
2. 返工和升级次数是否下降？如果没有下降，是任务本身模糊还是分工有问题？
3. Claude / Codex 的额度消耗差多少？是否值得为省下的时间付出这些额度？
4. 哪些任务类型（UI、后端、重构、排障）适合多 agent，哪些不适合？下一轮按类型调整候选路由。

只报告真实结果。样本只有 10 个任务时，不要把它写成普遍结论；注明任务类型、仓库和日期。