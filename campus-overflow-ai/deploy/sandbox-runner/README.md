# 容器运行时沙箱（P0-2）

外部命令、浏览器与文件执行的隔离边界。策略层在 Agent 进程内先做路径、命令、网络、超时与审批决策；本目录负责“进程真正跑起来之后”的内核级隔离。

## 当前状态

- 已提供 Compose 定义并通过 `docker compose config --quiet`。
- 尚未接入任何真实命令工具：Agent 当前唯一外部进程是只读 `agent-browser`，走本机策略层执行器（`agent/src/sandbox/`），不进入本容器。
- 接入新命令工具时，必须把执行入口改为本容器，不得回退到宿主直接 `spawn`。

## 隔离项

| 边界 | 配置 |
| --- | --- |
| 网络 | `network_mode: "none"`，完全断网 |
| 运行时 | `SANDBOX_RUNTIME=runsc` 启用 gVisor；默认 runc 仅本地验证 |
| 文件系统 | 根只读；`/tmp`、`/workspace` 为 tmpfs，`noexec,nosuid,nodev` |
| 权限 | 非 root（65534）、`cap_drop: ALL`、`no-new-privileges` |
| 资源 | 512 MiB 内存、1 CPU、128 PID、nofile 256 |
| 凭证 | 不注入任何环境变量、不挂载宿主目录、不连接数据库 |
| 进程 | `init: true` 回收僵尸进程，退出宽限 5 秒 |

## 启动与验证

```bash
cd campus-overflow-ai/deploy/sandbox-runner
docker compose config --quiet          # 仅校验配置，不需要引擎或 gVisor
docker run --rm --runtime=runsc alpine:3.20 uname -a   # 验证 gVisor 可用（Linux）
SANDBOX_RUNTIME=runsc docker compose run --rm exec     # 输出 node 版本
```

Windows / macOS 的 Docker Desktop 不支持 `runsc`，只能在 Linux 主机或支持 gVisor 的编排平台上验证；未验证前不得声称已启用 gVisor。

## 仍需处理

- 沙箱内任务的文件进出必须使用一次性 tmpfs，不映射宿主工作区；产物只通过 stdout 回传并受策略层输出上限约束。
- 需要联网的任务拆分到受控检索工具，不在本容器内开放出站。
- 真实镜像构建、gVisor 冒烟与资源上限验证尚未执行，不计入生产验收。
