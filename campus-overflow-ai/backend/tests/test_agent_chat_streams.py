"""P0-3 聊天可恢复流：幂等登记、归属隔离、序号连续性、终态与过期清理。"""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.modules.governance.models import AgentChatStream, AgentChatStreamEvent
from tests.test_agent_run_ownership import actors as actors
from tests.test_agent_run_ownership import auth

REQUEST = str(uuid4())


def put_stream(client: TestClient, headers: dict, request_id: str = REQUEST, **body):
    return client.put(
        f"/internal/agent/user/chat-streams/{request_id}", headers=headers, json=body
    )


def append(client: TestClient, headers: dict, seq: int, event_type: str = "delta",
           data: str = '{"text":"片段"}', request_id: str = REQUEST):
    return client.post(
        f"/internal/agent/user/chat-streams/{request_id}/events",
        headers=headers,
        json={"seq": seq, "event_type": event_type, "data": data},
    )


def read(client: TestClient, headers: dict, after: int = 0, request_id: str = REQUEST):
    return client.get(
        f"/internal/agent/user/chat-streams/{request_id}",
        headers=headers,
        params={"after": after},
    )


def test_put_is_idempotent_and_keeps_first_run(client: TestClient, actors) -> None:
    headers = auth(actors[0])
    first = put_stream(client, headers, agent_run_id="run-1")
    second = put_stream(client, headers, agent_run_id="run-2")
    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["created"] is True
    assert second.json()["data"]["created"] is False
    assert second.json()["data"]["agent_run_id"] == "run-1"
    assert second.json()["data"]["status"] == "running"


@pytest.mark.parametrize("missing", ["service", "user"])
def test_all_chat_stream_writes_need_both_credentials(client: TestClient, actors, missing) -> None:
    headers = auth(actors[0])
    headers.pop("X-Service-Token" if missing == "service" else "Authorization")
    assert put_stream(client, headers).status_code == 401
    assert append(client, headers, 1).status_code == 401
    assert read(client, headers).status_code == 401
    assert client.post(
        f"/internal/agent/user/chat-streams/{REQUEST}/cancel", headers=headers
    ).status_code == 401


def test_other_user_cannot_read_append_or_cancel(
    client: TestClient, db_session: Session, actors,
) -> None:
    owner = auth(actors[0])
    other = auth(actors[1])
    assert put_stream(client, owner).status_code == 200
    assert read(client, other).status_code == 404
    assert append(client, other, 1).status_code == 404
    assert client.post(
        f"/internal/agent/user/chat-streams/{REQUEST}/cancel", headers=other
    ).status_code == 404
    assert db_session.query(AgentChatStreamEvent).count() == 0


def test_events_are_ordered_and_done_marks_succeeded(client: TestClient, actors) -> None:
    headers = auth(actors[0])
    assert put_stream(client, headers).status_code == 200
    assert append(client, headers, 1, "meta", '{"agentRunId":"r"}').status_code == 200
    assert append(client, headers, 2, "delta", '{"text":"答"}').status_code == 200
    assert append(client, headers, 3, "done", '{"finishReason":"stop"}').status_code == 200
    body = read(client, headers, 1).json()["data"]
    assert body["status"] == "succeeded"
    assert [item["seq"] for item in body["events"]] == [2, 3]
    assert append(client, headers, 4).status_code == 409


def test_sequence_must_be_contiguous_and_duplicate_idempotent(client: TestClient, actors) -> None:
    headers = auth(actors[0])
    assert put_stream(client, headers).status_code == 200
    assert append(client, headers, 2).status_code == 409
    assert append(client, headers, 1, data='{"text":"a"}').status_code == 200
    duplicate = append(client, headers, 1, data='{"text":"a"}')
    assert duplicate.status_code == 200
    assert duplicate.json()["data"]["duplicate"] is True
    assert append(client, headers, 1, data='{"text":"b"}').status_code == 409
    assert append(client, headers, 3).status_code == 409


def test_cancel_marks_error_as_cancelled_only_after_request(client: TestClient, actors) -> None:
    headers = auth(actors[0])
    assert put_stream(client, headers).status_code == 200
    cancel = client.post(f"/internal/agent/user/chat-streams/{REQUEST}/cancel", headers=headers)
    assert cancel.status_code == 200
    assert cancel.json()["data"]["cancel_requested"] is True
    assert append(client, headers, 1, "error", '{"message":"任务已取消"}').status_code == 200
    assert read(client, headers).json()["data"]["status"] == "cancelled"


def test_error_without_cancel_marks_failed(client: TestClient, actors) -> None:
    headers = auth(actors[0])
    assert put_stream(client, headers).status_code == 200
    assert append(client, headers, 1, "error", '{"message":"失败"}').status_code == 200
    assert read(client, headers).json()["data"]["status"] == "failed"
    repeated = client.post(f"/internal/agent/user/chat-streams/{REQUEST}/cancel", headers=headers)
    assert repeated.status_code == 200
    assert repeated.json()["data"]["status"] == "failed"


def test_cancel_is_idempotent_after_terminal(client: TestClient, actors) -> None:
    headers = auth(actors[0])
    assert put_stream(client, headers).status_code == 200
    assert append(client, headers, 1, "done", "{}").status_code == 200
    first = client.post(f"/internal/agent/user/chat-streams/{REQUEST}/cancel", headers=headers)
    second = client.post(f"/internal/agent/user/chat-streams/{REQUEST}/cancel", headers=headers)
    assert first.status_code == second.status_code == 200
    assert second.json()["data"]["cancel_requested"] is False
    assert second.json()["data"]["status"] == "succeeded"


def test_expired_stream_is_hidden_and_cleaned(
    client: TestClient, db_session: Session, actors,
) -> None:
    headers = auth(actors[0])
    assert put_stream(client, headers).status_code == 200
    assert append(client, headers, 1).status_code == 200
    row = db_session.query(AgentChatStream).one()
    row.expires_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=1)
    db_session.commit()
    assert read(client, headers).status_code == 404
    assert append(client, headers, 2).status_code == 404
    db_session.expire_all()
    assert db_session.query(AgentChatStream).count() == 0
    assert db_session.query(AgentChatStreamEvent).count() == 0


@pytest.mark.parametrize(
    "extra",
    [{"role": "admin"}, {"user_id": 1}, {"status": "succeeded"}],
)
def test_contract_rejects_identity_and_status_overrides(
    client: TestClient, actors, extra,
) -> None:
    headers = auth(actors[0])
    assert put_stream(client, headers, **extra).status_code == 400
    response = client.post(
        f"/internal/agent/user/chat-streams/{REQUEST}/events",
        headers=headers,
        json={"seq": 1, "event_type": "delta", "data": "{}", **extra},
    )
    assert response.status_code == 400
