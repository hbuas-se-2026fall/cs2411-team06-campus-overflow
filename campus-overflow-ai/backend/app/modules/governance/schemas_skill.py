# 工作流 skill 管理接口出入参（T-22B / SK-R01～R04）。
# 字段一律蛇形；content 固定为条件/步骤/提示/检查/阈值，禁止额外字段。
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class SkillContent(BaseModel):
    """skill 正文：只描述可复用路径，不承载工具授权或角色提升指令。"""

    model_config = {"extra": "forbid", "str_strip_whitespace": True}

    conditions: list[str] = Field(default_factory=list, max_length=20)
    steps: list[str] = Field(default_factory=list, max_length=20)
    tips: list[str] = Field(default_factory=list, max_length=20)
    checks: list[str] = Field(default_factory=list, max_length=20)
    max_tokens: int = Field(1500, ge=0, le=4000)


class SkillCreateRequest(BaseModel):
    """创建草稿：同时生成 version 1 草稿版本，未发布前不参与注入。"""

    model_config = {"extra": "forbid", "str_strip_whitespace": True}

    name: str = Field(..., min_length=1, max_length=200)
    task_type: str = Field(..., min_length=1, max_length=40)
    course_id: int | None = Field(None, ge=1, description="为空表示全局 skill")
    content: SkillContent


class SkillUpdateRequest(BaseModel):
    """编辑 skill 与草稿：已发布的版本内容不变，改动写入草稿版本。"""

    model_config = {"extra": "forbid", "str_strip_whitespace": True}

    name: str | None = Field(None, min_length=1, max_length=200)
    task_type: str | None = Field(None, min_length=1, max_length=40)
    course_id: int | None = Field(None, ge=1, description="为空表示全局 skill")
    content: SkillContent | None = None


class SkillPublishRequest(BaseModel):
    """发布：缺省发布当前草稿；指定 version 时回滚到已发布版本。"""

    model_config = {"extra": "forbid"}

    version: int | None = Field(None, ge=1, description="回滚目标版本，必须已发布")


class SkillStatusRequest(BaseModel):
    """启停：仅允许 active / disabled，归档使用删除接口。"""

    model_config = {"extra": "forbid"}

    status: Literal["active", "disabled"]


class SkillOut(BaseModel):
    """skill 元数据；current_version 指向当前注入版本。"""

    id: int
    name: str
    task_type: str
    course_id: int | None = None
    status: str
    current_version: int | None = None
    created_by: int | None = None
    updated_by: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SkillVersionOut(BaseModel):
    """版本内容；source_run_id 关联提案来源运行。"""

    skill_id: int
    version: int
    content: SkillContent
    source_run_id: str | None = None
    status: str
    created_by: int | None = None
    published_by: int | None = None
    published_at: datetime | None = None
    created_at: datetime | None = None


class SkillDetailOut(SkillOut):
    """详情：元数据 + 全部历史版本（含草稿）。"""

    versions: list[SkillVersionOut] = Field(default_factory=list)
