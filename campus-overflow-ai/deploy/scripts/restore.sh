#!/usr/bin/env sh
set -eu

if [ "${1:-}" = "" ]; then
  echo "用法：CONFIRM_RESTORE=YES restore.sh <backup.sql.gz>" >&2
  exit 2
fi
if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then
  echo "恢复会覆盖当前数据库。确认后使用 CONFIRM_RESTORE=YES 重新执行。" >&2
  exit 2
fi

backup_file=$1
if [ ! -s "$backup_file" ]; then
  echo "备份文件不存在或为空：$backup_file" >&2
  exit 2
fi

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$deploy_dir/docker-compose.prod.yml"

cd "$deploy_dir/.."
gzip -dc "$backup_file" | docker compose --env-file "$deploy_dir/.env" -f "$compose_file" exec -T mysql \
  sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" campus_overflow'
echo "恢复完成：$backup_file"
