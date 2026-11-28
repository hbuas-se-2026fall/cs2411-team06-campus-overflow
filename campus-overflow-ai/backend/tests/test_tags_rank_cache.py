# 标签与榜单缓存测试：按 key 命中缓存，换 key 重新查询
from types import SimpleNamespace

from app.modules.identity import service as identity_service
from app.modules.interaction import repository as interaction_repository
from app.modules.interaction import service as interaction_service
from app.modules.qa import repository as qa_repository
from app.modules.qa import service as qa_service
from app.modules.qa.schemas import TagResponse


def test_tags_cached_by_keyword_and_hot(monkeypatch) -> None:
    """相同 (keyword, hot) 只查一次；任一维度变化都重新查询。"""
    calls: list[tuple] = []

    def fake_list_tags(db, keyword, hot):
        calls.append((keyword, hot))
        return [TagResponse(id=1, name=keyword or "全部", type="custom", question_count=1)]

    monkeypatch.setattr(qa_repository, "list_tags", fake_list_tags)

    assert qa_service.list_tags(None, None, False)[0].name == "全部"
    assert qa_service.list_tags(None, None, False)[0].name == "全部"
    assert qa_service.list_tags(None, "算法", False)[0].name == "算法"
    assert qa_service.list_tags(None, "算法", True)[0].name == "算法"

    assert calls == [(None, False), ("算法", False), ("算法", True)]


def test_rank_cached_by_period_and_course(monkeypatch) -> None:
    """相同 (period, course_id) 复用 RankResponse；换 key 重新计算。"""
    total_calls: list[int] = []
    batch_calls: list[tuple] = []

    def fake_total_rank(db, limit):
        total_calls.append(limit)
        return [SimpleNamespace(user_id=1, username="alice", score=10)]

    def fake_batch(db, period, course_id, last_score, last_user_id, as_of):
        batch_calls.append((period, course_id))
        return []

    monkeypatch.setattr(identity_service, "list_reputation_rank", fake_total_rank)
    monkeypatch.setattr(
        interaction_repository, "list_rank_candidate_batch", fake_batch
    )

    first = interaction_service.rank(None, "all", None)
    second = interaction_service.rank(None, "all", None)
    assert total_calls == [interaction_service.domain.RANK_LIMIT]
    assert [item.model_dump() for item in first.items] == [
        item.model_dump() for item in second.items
    ]

    interaction_service.rank(None, "week", None)
    interaction_service.rank(None, "week", None)
    assert batch_calls == [("week", None)]


def test_rank_different_course_is_separate_key(monkeypatch) -> None:
    """同一 period 下 course_id 不同不共享缓存。"""
    batch_calls: list[tuple] = []

    def fake_batch(db, period, course_id, last_score, last_user_id, as_of):
        batch_calls.append((period, course_id))
        return []

    monkeypatch.setattr(
        interaction_repository, "list_rank_candidate_batch", fake_batch
    )

    interaction_service.rank(None, "week", None)
    interaction_service.rank(None, "week", 7)
    interaction_service.rank(None, "week", 7)

    assert batch_calls == [("week", None), ("week", 7)]
