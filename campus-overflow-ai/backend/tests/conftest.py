# pytest 配置：使用 SQLite 内存数据库做单元测试，覆盖 get_db 依赖
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.modules.courses.service import course_list_cache
from app.modules.interaction.service import rank_cache
from app.modules.qa.service import tag_list_cache

# SQLite 内存数据库：StaticPool 保证多线程共享同一连接
engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture(autouse=True)
def setup_db() -> Generator[None, None, None]:
    """每个测试前建表、测试后删表，保证用例隔离。"""
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(autouse=True)
def clear_read_caches() -> Generator[None, None, None]:
    """进程内读缓存跨测试共享，逐测试清空，避免上一个用例的数据残留串扰。"""
    for cache in (course_list_cache, tag_list_cache, rank_cache):
        cache.clear()
    yield


def override_get_db() -> Generator[Session, None, None]:
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db_session() -> Generator[Session, None, None]:
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
