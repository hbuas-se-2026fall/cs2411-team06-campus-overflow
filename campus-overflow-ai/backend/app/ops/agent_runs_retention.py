"""运行记录归档与清理（T-16-D）。

安全口径：
- 只清理 succeeded / failed 的 agent_runs，running 一律保留；
- 默认必须先写归档 JSONL 再删除；未配置归档目录时拒绝执行，
  除非显式 --purge-without-archive 承担不可恢复风险；
- 删除顺序为 agent_run_events → tool_call_logs → agent_runs，遵守外键；
- 归档内容只含运行摘要与事件元数据，不含模型原文或凭据（C-07/C-08）。

用法：
  python -m app.ops.agent_runs_retention --days 90 --archive-dir D:/archive/agent-runs
  python -m app.ops.agent_runs_retention --days 90 --dry-run
"""

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.modules.governance import repository_retention as repo


def _utcnow() -> datetime:
    """数据库存本地无时区时间，统一用 UTC naive 计算截止点，避免跨时区漂移。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _write_archive(archive_dir: Path, rows: dict[str, list[dict]], stamp: str) -> Path:
    """把一批运行按“一行一条运行”写成 JSONL，写入并落盘后才允许删除。"""
    archive_dir.mkdir(parents=True, exist_ok=True)
    path = archive_dir / f"agent_runs_{stamp}.jsonl"
    events_by_run: dict[str, list[dict]] = {}
    for event in rows["events"]:
        events_by_run.setdefault(event["agent_run_id"], []).append(event)
    calls_by_run: dict[str, list[dict]] = {}
    for call in rows["tool_calls"]:
        calls_by_run.setdefault(call["agent_run_id"], []).append(call)
    with path.open("a", encoding="utf-8") as handle:
        for run in rows["runs"]:
            line = {
                "agent_run": run,
                "events": events_by_run.get(run["agent_run_id"], []),
                "tool_calls": calls_by_run.get(run["agent_run_id"], []),
            }
            handle.write(json.dumps(line, ensure_ascii=False, default=str) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return path


def purge_expired_runs(
    db: Session,
    *,
    before: datetime,
    archive_dir: str = "",
    batch_size: int = 500,
    dry_run: bool = False,
    purge_without_archive: bool = False,
) -> dict:
    """删除早于 before 的已结束运行；dry_run 只统计不写不删。"""
    if dry_run:
        return {
            "dry_run": True,
            "expired_runs": repo.count_expired_runs(db, before),
            "deleted": {"runs": 0, "events": 0, "tool_calls": 0},
        }
    archive_path = archive_dir.strip()
    if not archive_path and not purge_without_archive:
        raise RuntimeError(
            "未配置归档目录：请指定 archive_dir，或显式允许不归档删除（不可恢复）"
        )

    totals = {"runs": 0, "events": 0, "tool_calls": 0}
    archived_files: list[str] = []
    stamp = _utcnow().strftime("%Y%m%dT%H%M%SZ")
    while True:
        run_ids = repo.list_expired_run_ids(db, before, batch_size)
        if not run_ids:
            break
        if archive_path:
            rows = repo.collect_archive_rows(db, run_ids)
            archived_files.append(str(_write_archive(Path(archive_path), rows, stamp)))
        runs, events, calls = repo.delete_run_batch(db, run_ids)
        db.commit()
        totals["runs"] += runs
        totals["events"] += events
        totals["tool_calls"] += calls
    return {
        "dry_run": False,
        "before": before.isoformat(),
        "deleted": totals,
        "archive_files": archived_files,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="运行记录归档与清理（T-16-D）")
    parser.add_argument("--days", type=int, default=settings.agent_run_retention_days,
                        help="保留天数，早于该天数的已结束运行会被归档并删除")
    parser.add_argument("--archive-dir", default=settings.agent_run_archive_dir,
                        help="归档目录；为空且未显式允许时拒绝删除")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--dry-run", action="store_true", help="只统计，不写归档也不删除")
    parser.add_argument("--purge-without-archive", action="store_true",
                        help="允许不归档直接删除（不可恢复）")
    args = parser.parse_args(argv)
    if args.days < 1:
        parser.error("--days 必须大于 0")

    before = _utcnow() - timedelta(days=args.days)
    db = SessionLocal()
    try:
        result = purge_expired_runs(
            db,
            before=before,
            archive_dir=args.archive_dir,
            batch_size=max(1, args.batch_size),
            dry_run=args.dry_run,
            purge_without_archive=args.purge_without_archive,
        )
    finally:
        db.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
