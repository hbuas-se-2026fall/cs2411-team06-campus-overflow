# CampusOverflow AI 业务后端镜像（一期：backend + MySQL 即可运行）
# 基础镜像 python:3.11-slim 已通过国内加速源预拉并打标；依赖安装走清华 PyPI 镜像。
FROM python:3.11-slim

WORKDIR /app

# 拷贝清单与源码后一次性安装运行时依赖（仅主依赖组，不含 dev/redis/otel）
COPY pyproject.toml ./
COPY app ./app
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir -i ${PIP_INDEX_URL} .

# 迁移脚本、入口脚本与应用入口
COPY alembic.ini ./
COPY alembic ./alembic
COPY docker-entrypoint.sh ./

EXPOSE 8000

# 入口按 CPU/内存计算 worker，先执行迁移再启动 API（ADR-012）
CMD ["sh", "docker-entrypoint.sh"]
