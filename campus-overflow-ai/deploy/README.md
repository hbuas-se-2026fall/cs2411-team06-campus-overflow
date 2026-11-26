# 三服务生产部署

本目录提供 Nginx + frontend + agent + backend + MySQL 的生产形态。Agent 的 Workflow PostgreSQL
仍按 Agent README 作为独立可选依赖，不在默认 Compose 中隐式创建。

## 首次部署

```sh
cd campus-overflow-ai/deploy
cp .env.prod.example .env
# 修改所有 replace-with-*；AI 问答需填写 OPENAI_API_KEY，再执行：
cd ..
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml up -d --build
```

公网只映射 Nginx。backend、agent、MySQL 不直接暴露端口；`/internal/agent/**` 由 Nginx 返回 404。

## 迁移、备份与恢复

```sh
sh deploy/scripts/migrate.sh
sh deploy/scripts/backup.sh
CONFIRM_RESTORE=YES sh deploy/scripts/restore.sh deploy/backups/campus-overflow-YYYYmmdd-HHMMSS.sql.gz
```

备份默认写入 `deploy/backups/`，该目录不得提交 Git。恢复默认拒绝执行，必须显式确认。

## HTTPS

默认配置只监听 HTTP，便于首次启动和健康检查。生产必须按 `nginx/README.md` 使用已备案域名、
有效证书和 HTTPS 配置。证书/私钥不得提交仓库。

## 真实环境验收边界

本地 Compose 配置和镜像构建只证明部署件结构正确。真实 MySQL 迁移/恢复、模型、SSE、
外部 MCP、多实例容量、云安全组和证书仍需在目标服务器执行后才能标记验收完成。
