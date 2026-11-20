# 群聊 Windows 构建与交付

群聊在 VPS2 的 Git Worktree 修改代码。配置了 Windows 验收的群聊会先合成待交付补丁，在 Windows Bridge 的独立目录编译和测试，再让 Claude 根据结果验收。用户确认后才应用补丁。

## 配置

VPS2 的群聊工作区配置可登记 `"isolatedTests": ["windows-build"]`。设置 `"defaultIsolatedTest": "windows-build"` 后，该工作区中新建的群聊开发任务默认选择这一验收命令。通过管理命令显式指定已登记的命令时，按显式选择执行。在 VPS2 的模型步骤中完成普通 Linux 检查。

Windows Bridge 同名工作区中的 `isolatedCommands` 由本机管理员配置。示例中的路径须换成该机器已有的受限构建执行器。Bridge 会把验证后的临时源码目录作为进程工作目录。执行器要提供此项目所需的编译工具，并限制项目构建脚本对宿主凭据、正式项目、桌面、网络及其他工作区的访问。执行器须退出时给出真实退出码，需要交付的文件须写回本次临时目录内的固定相对路径。

```json
{
  "isolatedCommands": {
    "windows-build": {
      "runner": ["C:/BuildTools/ProjectSandboxRunner.exe", "build"],
      "artifacts": ["output/Project.exe"]
    }
  }
}
```

测试目录只隔离项目文件。执行器负责限制构建进程的系统权限。新增的调用只接受已配置的命令名、已验证的版本和任务身份。项目依赖缓存如有需要，由受限执行器按项目和依赖锁文件复用。

## 验收与回滚

- 首次传压缩快照。之后传完整校验清单和变化文件的内容，未变内容在 Bridge 上校验后复用。清单中已删除的文件不会进入下一次构建目录。同步确认结果丢失时可查验同版本的源文件，基线缺失或校验失败时可用完整快照重建。
- 已确认的构建失败优先交回原开发者和会话，按配置限制修复次数。补丁内容未改动时暂停重复构建。测试请求断开后可通过任务的「核对操作」查询原结果。
- 「产物」面板提供原构建文件，保存前会核对 SHA-256。Windows Bridge 按现有流文件清理周期保留产物。补丁应用前比较基线、测试命令、测试结果和当前补丁 SHA-256。
- 报表 JSON 中的 `windowsSyncPayloadBytes` 是已确认同步的压缩载荷大小之和。实际 SSH 流量、重发流量和模型 token 另行计算。
- `bridgeMcpRequests` 汇总每次 CLI 调用期间经授权的 Bridge MCP 请求。它不包括 CLI 原生读写、外部 MCP 服务或未恢复的内存计数。

在开发仓库运行下列命令。测试使用临时 Git 项目和模拟 CLI。安装了 .NET Framework C# 编译器的 Windows 会实际先编译失败，修复后再生成并运行 EXE，获取产物并核对 PE 文件头与哈希。

```powershell
node --test test/group-planning.test.js test/test-snapshot.test.js
npm test
```

正式切换前按 [部署手册](DEPLOY.md) 记录二进制版本，备份设置、任务数据库及会话数据，开启维护模式并等待任务排空。先更新 VPS2，再更新桌面端，使用临时项目核对真实 Bridge、受限执行器、官方 CLI 返工、最终验收和产物保存。回滚时先停止领取新任务，再用部署前备份恢复两端代码和配置，保留数据库、已有 Worktree 和待应用补丁。生产性能对照按 [基准测量](BENCHMARK.md) 使用相同基线、任务和验收条件采集。
