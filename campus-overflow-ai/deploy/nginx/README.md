# Nginx 与 TLS

默认 `default.conf` 仅监听 HTTP，用于首次部署与健康检查。公网生产必须在反向代理或云负载均衡终止 TLS，不能把 MySQL、backend、agent 端口直接暴露到公网。

同目录提供 `default.ssl.conf.example`。启用 HTTPS 时：

1. 将证书挂载到 `deploy/nginx/certs/fullchain.pem` 与 `privkey.pem`；
2. 用 `default.ssl.conf.example` 替换 Compose 中的 `default.conf` 挂载；
3. 将 Compose 的 `${HTTP_PORT}` 映射到 80，并按需要增加 443 映射；
4. 证书和私钥不得提交仓库。

所有浏览器请求都走 frontend：

- `/` → Next.js；
- `/api/backend/**` → Next.js BFF → backend；
- `/api/agent/**` → Next.js BFF → agent；
- `/internal/agent/**` 必须返回 404，禁止公网访问。

SSE 路径关闭代理缓冲并延长读超时。
