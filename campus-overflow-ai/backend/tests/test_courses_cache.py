# 课程列表缓存测试：共享缓存只覆盖核心数据，joined 实时查询，mine 按查看者隔离
from datetime import datetime

from app.modules.courses import repository, service
from app.modules.courses.schemas import CourseResponse
from app.modules.identity import service as identity_service


def _course(course_id: int, teacher_id: int) -> CourseResponse:
    now = datetime(2026, 1, 1, 12, 0, 0)
    return CourseResponse(
        id=course_id,
        name=f"课程{course_id}",
        code=f"CS{course_id}",
        description=None,
        semester="2025-2026-1",
        teacher_id=teacher_id,
        created_at=now,
        updated_at=now,
    )


def _patch(monkeypatch, courses: list[CourseResponse], list_calls: list[tuple],
           member_calls: list[int | None], joined_for: dict[int, set[int]] | None = None):
    """安装 repository / identity 假实现，并记录调用入参。"""

    def fake_list_courses(db, page, page_size, keyword, semester, mine=False, viewer_id=None):
        list_calls.append((page, page_size, keyword, semester, mine, viewer_id))
        if mine and viewer_id is not None:
            return [c for c in courses if c.teacher_id == viewer_id], {}, 1
        return courses, {c.id: c.id + 10 for c in courses}, len(courses)

    def fake_member_course_ids(db, user_id, course_ids):
        member_calls.append(user_id)
        if joined_for is None:
            return set()
        return joined_for.get(user_id, set()) & set(course_ids)

    monkeypatch.setattr(repository, "list_courses", fake_list_courses)
    monkeypatch.setattr(repository, "member_course_ids", fake_member_course_ids)
    monkeypatch.setattr(
        identity_service, "get_usernames_by_ids",
        lambda db, ids: {teacher_id: f"教师{teacher_id}" for teacher_id in ids},
    )


def test_same_filter_queries_repository_once(monkeypatch) -> None:
    """相同筛选条件重复调用只查一次仓库，但 joined 每次都实时查询。"""
    list_calls: list[tuple] = []
    member_calls: list[int | None] = []
    _patch(monkeypatch, [_course(1, 7)], list_calls, member_calls)

    first_items, first_total = service.list_courses(
        None, 1, 20, None, None, mine=False, viewer_id=1
    )
    second_items, second_total = service.list_courses(
        None, 1, 20, None, None, mine=False, viewer_id=1
    )

    assert len(list_calls) == 1
    assert member_calls == [1, 1]
    assert first_total == second_total == 1
    assert first_items[0].model_dump() == second_items[0].model_dump()
    assert first_items[0].teacher_name == "教师7"
    assert first_items[0].member_count == 11


def test_different_filters_query_separately(monkeypatch) -> None:
    """keyword / semester / 分页任一不同都视为新 key，各查一次仓库。"""
    list_calls: list[tuple] = []
    member_calls: list[int | None] = []
    _patch(monkeypatch, [_course(1, 7)], list_calls, member_calls)

    service.list_courses(None, 1, 20, None, None)
    service.list_courses(None, 1, 20, "数据", None)
    service.list_courses(None, 2, 20, None, None)

    assert len(list_calls) == 3
    assert [call[2] for call in list_calls] == [None, "数据", None]
    assert [call[0] for call in list_calls] == [1, 1, 2]


def test_joined_is_never_cached(monkeypatch) -> None:
    """核心数据命中缓存时，不同查看者的 joined 仍按各自实时结果返回。"""
    list_calls: list[tuple] = []
    member_calls: list[int | None] = []
    _patch(
        monkeypatch, [_course(1, 7)], list_calls, member_calls,
        joined_for={1: {1}, 2: set()},
    )

    joined_one, _ = service.list_courses(None, 1, 20, None, None, viewer_id=1)
    joined_two, _ = service.list_courses(None, 1, 20, None, None, viewer_id=2)

    assert len(list_calls) == 1  # 只缓存一次核心数据
    assert member_calls == [1, 2]  # joined 每次实时查询
    assert joined_one[0].joined is True
    assert joined_two[0].joined is False


def test_mine_cache_isolated_per_viewer(monkeypatch) -> None:
    """mine=true 不共享缓存：不同查看者各查一次，互不串数据。"""
    courses = [_course(1, 7), _course(2, 8)]
    list_calls: list[tuple] = []
    member_calls: list[int | None] = []
    _patch(monkeypatch, courses, list_calls, member_calls)

    mine_one, _ = service.list_courses(None, 1, 20, None, None, mine=True, viewer_id=7)
    mine_two, _ = service.list_courses(None, 1, 20, None, None, mine=True, viewer_id=8)

    assert [call[5] for call in list_calls] == [7, 8]
    assert [item.teacher_name for item in mine_one] == ["教师7"]
    assert [item.teacher_name for item in mine_two] == ["教师8"]
