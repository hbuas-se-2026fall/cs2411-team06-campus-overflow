# 运行控制接口出入参（T-21B / RC-R01～R05）：管理端与内部 Agent 共用。
# 字段一律蛇形；引导正文只在 ack 前短暂存在，不进入长期审计。
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class RunControlRequest(BaseModel):
    """管理端控制命令：pause / resume / cancel，必须携带期望 revision。"""

    model_config = {"extra": "forbid", "str_strip_whitespace": True}

    action: Literal["pause", "resume", "cancel"]
    expected_revision: int = Field(..., ge=0, description="期望的控制版本，用于并发互斥")


class RunGuidanceRequest(BaseModel):
    """管理员追加引导词：暂停期间可写，恢复后在下一模型调用前注入。"""

    model_config = {"extra": "forbid", "str_strip_whitespace": True}

    guidance_text: str = Field(..., min_length=1, max_length=2000, description="引导词正文")
    expected_revision: int = Field(..., ge=0, description="期望的控制版本，用于并发互斥")


class RunControlOut(BaseModel):
    """控制状态出参（管理端回显与内部拉取共用）。"""

    agent_run_id: str
    state: str
    revision: int
    pause_deadline: datetime | None = None
    updated_by: int | None = None
    updated_at: datetime | None = None


class RunCommandOut(BaseModel):
    """待消费命令；guidance_text 仅在下发时存在，ack 后清空。"""

    id: int
    revision: int
    action: str
    guidance_text: str | None = None
    guidance_digest: str | None = None
    status: str
    requested_by: int | None = None
    trace_id: str = ""
    created_at: datetime | None = None
    applied_at: datetime | None = None


class InternalRunControlOut(BaseModel):
    """内部拉取出参：状态 + since_revision 之后的未消费命令。"""

    enabled: bool
    state: str
    revision: int
    pause_deadline: datetime | None = None
    commands: list[RunCommandOut] = Field(default_factory=list)


class RunControlAckRequest(BaseModel):
    """Agent 消费确认：重复 ack 幂等，返回本次实际标记数量。"""

    model_config = {"extra": "forbid"}

    command_ids: list[int] = Field(default_factory=list, max_length=50)
