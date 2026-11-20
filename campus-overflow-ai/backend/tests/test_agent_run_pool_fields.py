# SA-03：内部运行接口接受并回显子 Agent 归属字段，槽位不一致时明确拒绝。

from fastapi.testclient import TestClient

from app.core.config import settings

SERVICE = {"X-Service-Token": settings.agent_service_token}


def _create_run(client: TestClient, run_id: str, **extra) -> object:
    payload = {
        "task_type": "moderation_scan",
        "agent_run_id": run_id,
        "input_summary": "扫描问题",
    }
    payload.update(extra)
    return client.post("/internal/agent/runs", headers=SERVICE, json=payload)


def test_subagent_run_echoes_pool_fields(client: TestClient) -> None:
    response = _create_run(
        client, "swe-child-1",
        actor_kind="governance", parent_run_id="swe-main-1",
        slot_kind="governance", slot_id="gov-1",
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert (data["actor_kind"], data["parent_run_id"], data["slot_kind"], data["slot_id"]) == (
        "governance", "swe-main-1", "governance", "gov-1",
    )


def test_main_run_and_legacy_run_keep_slots_empty(client: TestClient) -> None:
    main = _create_run(client, "swe-main-2", actor_kind="main")
    assert main.status_code == 200
    assert main.json()["data"]["slot_kind"] is None
    assert main.json()["data"]["slot_id"] is None

    legacy = _create_run(client, "swe-legacy-1")
    assert legacy.status_code == 200
    data = legacy.json()["data"]
    assert (data["actor_kind"], data["parent_run_id"], data["slot_kind"], data["slot_id"]) == (
        None, None, None, None,
    )


def test_inconsistent_slot_scope_rejected(client: TestClient) -> None:
    mismatch = _create_run(
        client, "swe-bad-1", actor_kind="qa", slot_kind="governance", slot_id="gov-1"
    )
    missing_slot = _create_run(client, "swe-bad-2", actor_kind="governance", slot_kind="governance")
    main_with_slot = _create_run(client, "swe-bad-3", actor_kind="main", slot_id="qa-1")

    assert mismatch.status_code == 400
    assert missing_slot.status_code == 400
    assert main_with_slot.status_code == 400
