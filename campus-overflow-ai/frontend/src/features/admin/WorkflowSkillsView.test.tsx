import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  fetchSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  publishSkill: vi.fn(),
  setSkillStatus: vi.fn(),
  archiveSkill: vi.fn(),
}));

vi.mock("@/api/workflow-skills", () => mocks);

import { WorkflowSkillsView } from "./WorkflowSkillsView";

const SKILL = {
  id: 1,
  name: "治理巡检路径",
  task_type: "moderation_scan",
  course_id: null,
  status: "draft",
  current_version: null,
  created_by: 9,
  updated_by: 9,
  created_at: "2026-11-26T09:00:00+08:00",
  updated_at: "2026-11-26T09:00:00+08:00",
};

const DETAIL = {
  ...SKILL,
  versions: [{
    skill_id: 1,
    version: 1,
    content: {
      conditions: ["发现批量相似内容"],
      steps: ["核对来源", "生成待审批工单"],
      tips: [],
      checks: ["不得直接执行"],
      max_tokens: 1200,
    },
    source_run_id: null,
    status: "draft",
    created_by: 9,
    published_by: null,
    published_at: null,
    created_at: "2026-11-26T09:00:00+08:00",
  }],
};

const ACTIVE_SKILL = {
  ...SKILL,
  id: 2,
  name: "已发布巡检路径",
  status: "active",
  current_version: 1,
};

beforeEach(() => {
  mocks.listSkills.mockReset().mockResolvedValue({
    items: [SKILL],
    total: 1,
    page: 1,
    page_size: 20,
  });
  mocks.fetchSkill.mockReset().mockResolvedValue(DETAIL);
  mocks.createSkill.mockReset().mockResolvedValue(SKILL);
  mocks.updateSkill.mockReset().mockResolvedValue(SKILL);
  mocks.publishSkill.mockReset().mockResolvedValue(SKILL);
  mocks.setSkillStatus.mockReset().mockResolvedValue(SKILL);
  mocks.archiveSkill.mockReset().mockResolvedValue(SKILL);
});

afterEach(cleanup);

describe("WorkflowSkillsView", () => {
  it("展示列表并按状态筛选", async () => {
    render(<WorkflowSkillsView />);
    expect(await screen.findByText("治理巡检路径")).toBeTruthy();
    const row = screen.getByText("治理巡检路径").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("草稿")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("状态"), { target: { value: "active" } });
    await waitFor(() =>
      expect(mocks.listSkills).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "active", page: 1 }),
      ),
    );

    fireEvent.change(screen.getByLabelText("课程 ID 筛选"), { target: { value: "2" } });
    await waitFor(() =>
      expect(mocks.listSkills).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "active", course_id: 2, page: 1 }),
      ),
    );
  });

  it("创建 skill 草稿并提交结构化内容", async () => {
    render(<WorkflowSkillsView />);
    await screen.findByText("治理巡检路径");

    fireEvent.click(screen.getByRole("button", { name: "新建 Skill" }));
    const dialog = screen.getByRole("dialog", { name: "新建 Skill" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "周报复用路径" } });
    fireEvent.change(within(dialog).getByLabelText("任务类型"), { target: { value: "teaching_report" } });
    fireEvent.change(within(dialog).getByLabelText("适用条件"), {
      target: { value: "每周生成周报\n存在知识树" },
    });
    fireEvent.change(within(dialog).getByLabelText("执行步骤"), {
      target: { value: "汇总本周问题\n定位未覆盖主题" },
    });
    fireEvent.change(within(dialog).getByLabelText("检查项"), {
      target: { value: "不含学生身份" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存草稿" }));

    await waitFor(() =>
      expect(mocks.createSkill).toHaveBeenCalledWith({
        name: "周报复用路径",
        task_type: "teaching_report",
        course_id: null,
        content: {
          conditions: ["每周生成周报", "存在知识树"],
          steps: ["汇总本周问题", "定位未覆盖主题"],
          tips: [],
          checks: ["不含学生身份"],
          max_tokens: 1500,
        },
      }),
    );
  });

  it("编辑时优先加载最新草稿，而不是旧发布版本", async () => {
    mocks.fetchSkill.mockResolvedValue({
      ...DETAIL,
      status: "active",
      current_version: 2,
      versions: [
        {
          ...DETAIL.versions[0],
          version: 3,
          status: "draft",
          content: {
            conditions: ["草稿条件"],
            steps: ["草稿步骤"],
            tips: [],
            checks: [],
            max_tokens: 900,
          },
        },
        {
          ...DETAIL.versions[0],
          version: 2,
          status: "published",
        },
      ],
    });
    render(<WorkflowSkillsView />);
    await screen.findByText("治理巡检路径");

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 Skill #1" });
    expect((within(dialog).getByLabelText("执行步骤") as HTMLTextAreaElement).value).toBe(
      "草稿步骤",
    );
    expect(within(dialog).getByText("v3 · 草稿")).toBeTruthy();
    expect(within(dialog).getByText("v2 · 已发布")).toBeTruthy();
    expect(within(dialog).getByText("当前版本")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "回滚到此版本" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "发布草稿" }));
    await waitFor(() => expect(mocks.publishSkill).toHaveBeenCalledWith(1));
  });

  it("编辑详情加载失败时关闭表单，避免误创建新 Skill", async () => {
    mocks.fetchSkill.mockRejectedValueOnce(new Error("详情加载失败"));
    render(<WorkflowSkillsView />);
    await screen.findByText("治理巡检路径");

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    expect((await screen.findByRole("alert")).textContent).toContain("详情加载失败");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("非法课程 ID 在本地拦截", async () => {
    render(<WorkflowSkillsView />);
    await screen.findByText("治理巡检路径");
    fireEvent.click(screen.getByRole("button", { name: "新建 Skill" }));
    const dialog = screen.getByRole("dialog", { name: "新建 Skill" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "测试 Skill" } });
    fireEvent.change(within(dialog).getByLabelText("课程 ID（留空表示全局）"), {
      target: { value: "0" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存草稿" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "课程 ID 必须是正整数",
    );
    expect(mocks.createSkill).not.toHaveBeenCalled();
  });

  it("发布成功后详情刷新失败不误报为发布失败", async () => {
    render(<WorkflowSkillsView />);
    await screen.findByText("治理巡检路径");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 Skill #1" });
    mocks.fetchSkill.mockRejectedValueOnce(new Error("详情刷新失败"));

    fireEvent.click(within(dialog).getByRole("button", { name: "发布草稿" }));
    expect(await within(dialog).findByText(/已发布，但详情刷新失败/)).toBeTruthy();
    expect(within(dialog).queryByText("发布失败")).toBeNull();
  });

  it("发布、启停与归档并二次确认", async () => {
    mocks.listSkills.mockResolvedValue({
      items: [SKILL, ACTIVE_SKILL],
      total: 2,
      page: 1,
      page_size: 20,
    });
    render(<WorkflowSkillsView />);
    const draftRow = (await screen.findByText("治理巡检路径")).closest("tr");
    const activeRow = screen.getByText("已发布巡检路径").closest("tr");
    expect(draftRow).not.toBeNull();
    expect(activeRow).not.toBeNull();

    fireEvent.click(within(draftRow!).getByRole("button", { name: "发布" }));
    await waitFor(() => expect(mocks.publishSkill).toHaveBeenCalledWith(1));

    fireEvent.click(within(activeRow!).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(mocks.setSkillStatus).toHaveBeenCalledWith(2, "disabled"));

    fireEvent.click(within(activeRow!).getByRole("button", { name: "归档" }));
    expect(screen.getByRole("dialog", { name: "确认归档 Skill" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(mocks.archiveSkill).toHaveBeenCalledWith(2));
  });

  it("归档末页最后一条后回到有效页", async () => {
    let archived = false;
    const firstPageSkill = {
      ...ACTIVE_SKILL,
      id: 3,
      name: "第一页路径",
    };
    mocks.listSkills.mockImplementation(async (params: { page: number }) => {
      const total = archived ? 20 : 21;
      const items = params.page === 1
        ? [firstPageSkill]
        : archived
          ? []
          : [ACTIVE_SKILL];
      return { items, total, page: params.page, page_size: 20 };
    });
    mocks.archiveSkill.mockImplementation(async () => {
      archived = true;
      return ACTIVE_SKILL;
    });
    render(<WorkflowSkillsView />);
    fireEvent.change(screen.getByLabelText("状态"), { target: { value: "active" } });
    await screen.findByText("第一页路径");

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(await screen.findByText("已发布巡检路径")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));

    await waitFor(() =>
      expect(mocks.listSkills).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1 }),
      ),
    );
  });
});
