# 部署与运维

## Ubuntu 部署

适用于 Ubuntu 22.04 或更新版本，运行依赖为系统 Python 3.10+、SQLite 标准库模块和 systemd。部署目录只需要 `relay/` 中的安装文件。构建和测试在开发机完成。

1. 准备 TLS fullchain 和私钥。证书 SAN 必须匹配两端连接的主机名或 IP。默认服务在 IPv4 `0.0.0.0:22022` 监听；绑定 IPv6 时使用 `::` 并仅监听 IPv6。两端应先确认到 VPS 1 的出站 TCP 可达。
2. 在可信工作站上分别运行两次 `python3 relay/generate_token.py`，为 Bridge 和 Orchestrator 各生成一个令牌。将摘要写入 `devices.example.json` 的副本，将原令牌通过独立渠道交给对应端。两端各只持有自己的令牌。生产注册表用两条互相配对的记录，名称建议使用新设备的独立 ID。
3. 将服务文件和部署所需的凭据传到 VPS 1，证书私钥存放在仅管理员可读的路径。安装脚本校验注册表及 TLS 密钥匹配后，部署服务、权限、内存限制及日志轮转，并启动和设为开机运行。

```bash
sudo bash relay/install-ubuntu.sh /secure/fullchain.pem /secure/privkey.pem /secure/devices.json
sudo systemctl status agentdesk-relay
sudo ss -lntp 'sport = :22022'
```

在 VPS 1 的主机及供应商防火墙允许实际配置的 Relay 端口。安装脚本不管理防火墙。未使用的地址族可在站点防火墙配置中收紧。需要改绑定地址或端口时，编辑 `/etc/agentdesk-relay/listen.env` 后重启服务。证书到期前更新 fullchain 和私钥，重新执行安装脚本以载入证书。

## 性能和日志

systemd 在 128 MiB 对服务施加内存回收压力，200 MiB 为硬上限。Relay 最多接受 16 条并发连接（包括 TLS 握手），每个设备 ID 仅有一条有效连接。回执库最多保存 100000 条记录，按 UUIDv7 时间在 24 小时后过期，每分钟清理一次。流式传输没有离线消息队列，回执库不含文件数据或命令正文。

独立的 journald 命名空间将日志限在约 32 MB，每份轮转文件最大 4 MB，最长保留 7 天。每分钟记录在线设备数和回执数。日志只包含服务状态、设备 ID 和错误码，不记录令牌、协议帧或文件正文。 [systemd 日志配置](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)

```bash
sudo journalctl --namespace=agentdesk-relay -u agentdesk-relay --since '1 hour ago'
systemctl show agentdesk-relay -p MemoryCurrent -p NRestarts -p ActiveState
sudo du -sh /var/lib/agentdesk-relay
```

生产验收从 Windows Bridge 和 VPS 2 分别完成 TLS 握手、认证及对端上线检测。两个方向各传一个多块文件并校验整文件摘要。中断其中一端网络及重启 Relay，确认重新上线、旧回执可查且同 ID 写操作没有重复投递。在实际并发负载下采集 `MemoryCurrent`、重启次数、磁盘余量、持续吞吐和 ACK 延迟。

## 吊销与恢复

- **轮换令牌**。为该设备生成独立令牌，将新摘要写入注册表副本。以 `root:agentdesk-relay`、`0640` 权限在同一目录原子替换 `/etc/agentdesk-relay/devices.json`。服务每 2 秒检查注册表，摘要变更时关闭受影响的连接。设备用新令牌重新连接。
- **吊销配对**。从注册表同时删除配对双方的记录。给同一物理设备重新分配身份时使用新的设备 ID。格式错误或者注册表不可读时，在线认证连接会关闭，修复后重新认证。
- **端口无法连接**。检查 systemd、`ss`、主机和供应商防火墙。TLS 失败时核对时钟、证书链、SAN、客户端信任库。认证失败时核对设备 ID、摘要和文件权限。
- **回执一直 pending**。原设备应查询接收方的任务记录。不要重放写操作、补丁或命令。磁盘满或回执库出错时，释放空间后保留原 SQLite 数据库及 WAL 让 systemd 重启服务。恢复备份时使用 SQLite 一致快照；丢失回执的时间段需要在端侧核对副作用。
- **回执容量不足**。减少频率或暂停大文件传输，观察清理周期和两端时钟。默认容量下，满尺寸文件块单独消耗回执时约覆盖 9.15 GiB/24h，其他帧也占用同一额度。按负载调整前先在开发环境验证磁盘、吞吐和恢复语义。

## 本地验证

```bash
python3 -m unittest discover -s relay/tests -v
node --test test/remote.test.js
bash -n relay/install-ubuntu.sh
```

集成测试用 OpenSSL 生成临时证书，在本机启动真实 TLS Relay 并连接两个模拟端点。
