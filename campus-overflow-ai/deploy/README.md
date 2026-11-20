# Deploy Structure

Deployment files live here.

- `nginx/`: reverse proxy configuration.
- `mysql/`: MySQL initialization assets.
- `redis/`: optional Redis configuration for later caching, rate limiting, or ranking.
- `backend.Dockerfile`: planned backend image definition.
- `frontend.Dockerfile`: planned frontend image definition.
- `agent.Dockerfile`: planned Agent image definition.
- `docker-compose.prod.yml`: planned production-like compose file.
- `mcp-sandbox/`: 外部 MCP 客户端只读沙箱（非 root、只读根、资源上限）。
- `sandbox-runner/`: 命令/浏览器/文件执行的容器运行时沙箱（默认断网，可启用 gVisor）。
- `test-sandbox/`: 本地 MySQL/Postgres 测试实例。

Phase 1 can start with local dev commands. Docker configuration should be added
when service contracts and health checks are stable.
