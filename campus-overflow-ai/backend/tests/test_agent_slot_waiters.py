# P0-5：全局问答排队的 FIFO、容量、过期与取消语义。

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.core.config import settings
from app.modules.governance.models import AgentSlotWaiter

SERVICE = {"X-Service-Token": settings.agent_service_token}


def _claim(client: TestClient, **overrides) -> object:
    payload = {
        "kind": "qa", "capacity": 1, "job_id": "job-held",
        "instance_id": "agent-a", "ttl_seconds": 60,
    }
    payload.update(overrides)
    return client.post("/internal/agent/slot-leases/claim", headers=SERVICE, json=payload)


def _enqueue(client: TestClient, **overrides) -> object:
    payload = {
        "kind": "qa", "capacity": 1, "job_id": "job-wait",
        "instance_id": "agent-a", "ttl_seconds": 60, "wait_seconds": 60,
    }
    payload.update(overrides)
    return client.post("/internal/agent/slot-leases/wait", headers=SERVICE, json=payload)


def _poll(client: TestClient, ticket_id: int) -> object:
    return client.post(
        f"/internal/agent/slot-leases/wait/{ticket_id}/poll", headers=SERVICE,
    )


def _release(client: TestClient, ticket: dict) -> None:
    response = client.post(
        f"/internal/agent/slot-leases/{ticket['kind']}/{ticket['slot_no']}/release",
        headers=SERVICE, json={"fencing_token": ticket["fencing_token"]},
    )
    assert response.status_code == 200


def test_enqueue_waits_until_capacity_released(client: TestClient) -> None:
    held = _claim(client)
    assert held.status_code == 200

    waiting = _enqueue(client)
    assert waiting.status_code == 200
    ticket = waiting.json()["data"]
    assert ticket["status"] == "waiting"
    assert ticket["position"] == 1
    assert "lease" not in ticket

    assert _poll(client, ticket["ticket_id"]).json()["data"]["status"] == "waiting"

    _release(client, held.json()["data"])
    granted = _poll(client, ticket["ticket_id"]).json()["data"]
    assert granted["status"] == "granted"
    assert granted["lease"]["slot_no"] == 1
    assert granted["lease"]["job_id"] == "job-wait"

    # 票据单次使用：取走租约后再次轮询为 404
    assert _poll(client, ticket["ticket_id"]).status_code == 404


def test_fifo_prevents_later_ticket_from_jumping(client: TestClient) -> None:
    held = _claim(client)
    first = _enqueue(client, job_id="job-first").json()["data"]
    second = _enqueue(client, job_id="job-second").json()["data"]
    assert first["position"] == 1
    assert second["position"] == 2

    _release(client, held.json()["data"])
    # 后到票据轮询只会推动队首获授，自己仍须等待
    after = _poll(client, second["ticket_id"]).json()["data"]
    assert after["status"] == "waiting"
    assert after["position"] == 1

    granted_first = _poll(client, first["ticket_id"]).json()["data"]
    assert granted_first["status"] == "granted"
    _release(client, granted_first["lease"])

    granted_second = _poll(client, second["ticket_id"]).json()["data"]
    assert granted_second["status"] == "granted"


def test_cancel_releases_granted_but_unclaimed_slot(client: TestClient) -> None:
    held = _claim(client)
    first = _enqueue(client, job_id="job-first").json()["data"]
    second = _enqueue(client, job_id="job-second").json()["data"]
    _release(client, held.json()["data"])

    # 后到票据触发晋升：first 已授予但尚未被取走
    assert _poll(client, second["ticket_id"]).json()["data"]["status"] == "waiting"

    cancelled = client.post(
        f"/internal/agent/slot-leases/wait/{first['ticket_id']}/cancel", headers=SERVICE,
    )
    assert cancelled.status_code == 200
    assert _poll(client, first["ticket_id"]).status_code == 404

    assert _poll(client, second["ticket_id"]).json()["data"]["status"] == "granted"


def test_expired_head_is_skipped(client: TestClient, db_session) -> None:
    held = _claim(client)
    first = _enqueue(client, job_id="job-first").json()["data"]

    row = db_session.get(AgentSlotWaiter, first["ticket_id"])
    row.expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
    db_session.commit()

    second = _enqueue(client, job_id="job-second").json()["data"]
    assert second["status"] == "waiting"

    _release(client, held.json()["data"])
    assert _poll(client, first["ticket_id"]).status_code == 404
    assert _poll(client, second["ticket_id"]).json()["data"]["status"] == "granted"


def test_validates_payload_and_requires_service_token(client: TestClient) -> None:
    # 全局异常处理器把 Pydantic 422 归一为 400（docs/接口设计指南.md）
    assert _enqueue(client, wait_seconds=5).status_code == 400
    assert _enqueue(client, capacity=0).status_code == 400
    assert _enqueue(client, kind="unknown").status_code == 400
    unauthenticated = client.post(
        "/internal/agent/slot-leases/wait",
        json={"kind": "qa", "capacity": 1, "job_id": "job-a",
              "instance_id": "agent-a", "ttl_seconds": 60},
    )
    assert unauthenticated.status_code == 401
