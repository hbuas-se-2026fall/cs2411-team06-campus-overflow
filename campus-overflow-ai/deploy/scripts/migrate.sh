#!/usr/bin/env sh
set -eu

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$deploy_dir/docker-compose.prod.yml"

cd "$deploy_dir/.."
docker compose --env-file "$deploy_dir/.env" -f "$compose_file" run --rm backend alembic upgrade head
