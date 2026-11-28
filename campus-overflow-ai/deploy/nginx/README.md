# Nginx（生产入口）

`default.conf` 是 http 上下文可 include 的 server 配置，镜像中挂载到 `/etc/nginx/conf.d/default.conf`。
它负责在请求到达后端前做连接数与速率保护，避免 10000 并发直打后端。

## 路由

| 路径 | 行为 |
| --- | --- |
| `/api/` | 反代到 `http://backend`（容器内 8000），保留原始路径 |
| `/health` | 反代到后端 `/health`，不参与限流 |
| `/internal/` | `deny all`，返回 403，绝不转发；`/internal/agent/*` 不对外暴露 |
| `/` | 暂返回 JSON 404，待前端接入后改为反代前端 |

## 限流阈值

- 每 IP 并发连接：`limit_conn api_conn 1000`（`limit_conn_zone` 10m 共享内存）。
- 每 IP 请求速率：`limit_req_zone ... rate=1000r/s`，`burst=2000` 且 `nodelay`（突发 2000 个请求立即放行，超出直接拒绝，不排队）。
- 超限返回：429（`limit_req_status 429`、`limit_conn_status 429`），503 也统一输出 JSON。

429 / 503 响应体统一为：

```json
{"code":429,"data":null,"message":"请求过于频繁，请稍后重试"}
```

`Content-Type: application/json; charset=utf-8`。503 时 `code` 为 503，message 同上。

`/health` 不限流，便于负载均衡与容器健康检查；`client_max_body_size` 为 10m。

## 如何调整阈值

1. 并发连接：修改 `location /api/` 中的 `limit_conn api_conn 1000;` 数值。
2. 速率与突发：修改 `limit_req_zone ... rate=1000r/s;` 的速率，以及 `location /api/` 中 `burst=2000`；`nodelay` 改为去掉后即为排队模式（延迟处理而非立即拒绝）。
3. 多 IP 段/共享内存容量：`zone=api_conn:10m`、`zone=api_req:10m` 的 10m 约可记录 16 万 IP 状态，IP 量大时按需调大。
4. 修改后执行 `docker exec <nginx 容器> nginx -t` 校验再 `nginx -s reload`（或用 compose 重建 nginx 服务）。

真实并发上限还要结合后端 worker 数与数据库连接池预算（见 `docker-compose.prod.yml` 中 `WEB_CONCURRENCY`、`DB_CONNECTION_POOL` 相关环境变量），入口阈值不应高于后端可承载量。

## 后续前端路由接入

前端上线后，把 `location /` 的占位 404 替换为前端反代，例如：

```nginx
location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://frontend:3000;
}
```

并在 `upstream` 增加 `frontend`；`/api/`、`/internal/` 规则保持不动。
