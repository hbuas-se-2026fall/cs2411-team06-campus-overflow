# P0-1：跨实例槽位租约的容量、fencing 与释放语义。

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.core.config import settings
from app.modules.governance.domain import SLOT_RETRY_BUDGET
from app.modules.governance.models import AgentSlotLease

SERVICE = {"X-Service-Token": settings.agent_service_token}


def _claim(client: TestClient, **overrides) -> object:
    payload = {
        "kind": "governance",
        "capacity": 2,
        "job_id": "job-a",
        "instance_id": "agent-a",
        "ttl_seconds": 60,
    }
    payload.update(overrides)
    return client.post("/internal/agent/slot-leases/claim", headers=SERVICE, json=payload)


def _token(response: object) -> dict:
    return response.json()["data"]


def test_claim_respects_capacity_and_reclaims_after_release(client: TestClient) -> None:
    first = _claim(client, job_id="job-a", instance_id="agent-a")
    second = _claim(client, job_id="job-b", instance_id="agent-b")
    assert first.status_code == 200
    assert second.status_code == 200
    assert {_token(first)["slot_no"], _token(second)["slot_no"]} == {1, 2}

    full = _claim(client, job_id="job-c", instance_id="agent-c")
    assert full.status_code == 409
    assert full.json()["message"] == "全局槽位已满"

    released = client.post(
        "/internal/agent/slot-leases/governance/1/release",
        headers=SERVICE, json={"fencing_token": _token(first)["fencing_token"]},
    )
    assert released.status_code == 200
    reclaimed = _claim(client, job_id="job-c", instance_id="agent-c")
    assert reclaimed.status_code == 200
    assert _token(reclaimed)["slot_no"] == 1


def test_renew_and_release_require_matching_fencing_token(client: TestClient) -> None:
    lease = _claim(client)
    assert lease.status_code == 200
    token = _token(lease)["fencing_token"]

    wrong_renew = client.post(
        "/internal/agent/slot-leases/governance/1/renew",
        headers=SERVICE, json={"fencing_token": "bad", "ttl_seconds": 60},
    )
    assert wrong_renew.status_code == 409

    renewed = client.post(
        "/internal/agent/slot-leases/governance/1/renew",
        headers=SERVICE, json={"fencing_token": token, "ttl_seconds": 60},
    )
    assert renewed.status_code == 200

    wrong_release = client.post(
        "/internal/agent/slot-leases/governance/1/release",
        headers=SERVICE, json={"fencing_token": "bad"},
    )
    assert wrong_release.status_code == 409
    assert client.post(
        "/internal/agent/slot-leases/governance/1/release",
        headers=SERVICE, json={"fencing_token": token},
    ).status_code == 200


def test_claim_validates_payload_and_service_token(client: TestClient) -> None:
    # 全局异常处理器把 Pydantic 422 归一为 400（docs/接口设计指南.md）
    assert _claim(client, capacity=0).status_code == 400
    assert _claim(client, kind="unknown").status_code == 400
    assert _claim(client, job_id="x").status_code == 400
    unauthenticated = client.post(
        "/internal/agent/slot-leases/claim",
        json={"kind": "qa", "capacity": 1, "job_id": "job-a",
              "instance_id": "agent-a", "ttl_seconds": 60},
    )
    assert unauthenticated.status_code == 401


def test_same_instance_cannot_steal_unexpired_slot_for_other_job(client: TestClient) -> None:
    """收紧条件：同实例的不同 job 不得顶替未过期租约，否则全局容量被绕过。"""
    first = _claim(client, capacity=1, job_id="job-a", instance_id="agent-a")
    assert first.status_code == 200

    second = _claim(client, capacity=1, job_id="job-b", instance_id="agent-a")
    assert second.status_code == 409
    assert second.json()["message"] == "全局槽位已满"


def test_same_job_retry_reclaims_own_slot_and_rotates_token(
    client: TestClient, db_session,
) -> None:
    first = _claim(client, capacity=1, job_id="job-a", instance_id="agent-a")
    retry = _claim(client, capacity=1, job_id="job-a", instance_id="agent-a")
    assert retry.status_code == 200
    assert _token(retry)["slot_no"] == _token(first)["slot_no"]
    assert _token(retry)["fencing_token"] != _token(first)["fencing_token"]

    lease = db_session.query(AgentSlotLease).filter_by(
        kind="governance", slot_no=_token(first)["slot_no"],
    ).one()
    assert lease.retry_count == SLOT_RETRY_BUDGET - 1

    # 旧 token 已被顶替，不能再续租
    stale = client.post(
        "/internal/agent/slot-leases/governance/1/renew",
        headers=SERVICE,
        json={"fencing_token": _token(first)["fencing_token"], "ttl_seconds": 60},
    )
    assert stale.status_code == 409


def test_same_job_takeover_across_instances_costs_one_retry(
    client: TestClient, db_session,
) -> None:
    first = _claim(client, capacity=1, job_id="job-a", instance_id="agent-a")
    takeover = _claim(client, capacity=1, job_id="job-a", instance_id="agent-b")
    assert takeover.status_code == 200
    assert _token(takeover)["slot_no"] == _token(first)["slot_no"]

    lease = db_session.query(AgentSlotLease).filter_by(kind="governance", slot_no=1).one()
    assert lease.owner_instance == "agent-b"
    assert lease.retry_count == SLOT_RETRY_BUDGET - 1


def test_retry_budget_exhausted_blocks_further_retry(
    client: TestClient, db_session,
) -> None:
    assert _claim(client, capacity=1, job_id="job-a").status_code == 200
    for _ in range(SLOT_RETRY_BUDGET):
        assert _claim(client, capacity=1, job_id="job-a").status_code == 200

    lease = db_session.query(AgentSlotLease).filter_by(kind="governance", slot_no=1).one()
    assert lease.retry_count == 0

    assert _claim(client, capacity=1, job_id="job-a").status_code == 409
    # 未过期且预算用尽的槽位，其他 job 也不可顶替
    assert _claim(client, capacity=1, job_id="job-b").status_code == 409


def test_exhausted_expired_slot_only_claimable_by_other_job(
    client: TestClient, db_session,
) -> None:
    assert _claim(client, capacity=1, job_id="job-a").status_code == 200
    lease = db_session.query(AgentSlotLease).filter_by(kind="governance", slot_no=1).one()
    lease.retry_count = 0
    lease.lease_expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
    db_session.commit()

    # 同一 job 预算归零：过期也不可重试
    assert _claim(client, capacity=1, job_id="job-a").status_code == 409

    # 其他 job 接管过期槽位视为新任务，预算重置
    other = _claim(client, capacity=1, job_id="job-b")
    assert other.status_code == 200
    db_session.expire_all()
    lease = db_session.query(AgentSlotLease).filter_by(kind="governance", slot_no=1).one()
    assert lease.job_id == "job-b"
    assert lease.retry_count == SLOT_RETRY_BUDGET


def test_expired_slot_is_reclaimed_by_another_instance(
    client: TestClient, db_session,
) -> None:
    first = _claim(client, capacity=1, job_id="job-a", instance_id="agent-a")
    assert first.status_code == 200

    row = db_session.query(AgentSlotLease).filter_by(
        kind="governance", slot_no=_token(first)["slot_no"],
    ).one()
    row.lease_expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
    db_session.commit()

    reclaimed = _claim(client, capacity=1, job_id="job-b", instance_id="agent-b")
    assert reclaimed.status_code == 200
    assert _token(reclaimed)["slot_no"] == _token(first)["slot_no"]
