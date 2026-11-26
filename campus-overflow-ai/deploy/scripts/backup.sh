#!/usr/bin/env sh
set -eu

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$deploy_dir/docker-compose.prod.yml"
backup_dir=${BACKUP_DIR:-"$deploy_dir/backups"}
timestamp=$(date +%Y%m%d-%H%M%S)
target="$backup_dir/campus-overflow-$timestamp.sql.gz"

mkdir -p "$backup_dir"
cd "$deploy_dir/.."

docker compose --env-file "$deploy_dir/.env" -f "$compose_file" exec -T mysql \
  sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers campus_overflow' \
  | gzip > "$target"

test -s "$target"
echo "备份完成：$target"
