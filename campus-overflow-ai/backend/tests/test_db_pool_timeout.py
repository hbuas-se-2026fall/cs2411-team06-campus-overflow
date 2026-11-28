from collections.abc import Generator

from fastapi.testclient import TestClient
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from app.db.session import get_db
from app.main import app


def test_pool_timeout_returns_503(client: TestClient) -> None:
    def _raise() -> Generator[None, None, None]:
        raise PoolTimeoutError("QueuePool limit reached")
        yield  # pragma: no cover

    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _raise
    try:
        response = client.get("/api/courses")
    finally:
        # conftest 在模块级安装了 SQLite 覆盖，必须恢复而不是直接删除
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous

    assert response.status_code == 503
    body = response.json()
    assert body["code"] == 503
    assert body["data"] is None
    assert body["reason_code"] == "db_pool_timeout"
    assert "稍后" in body["message"]
