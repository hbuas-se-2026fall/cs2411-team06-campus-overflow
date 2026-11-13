import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // session-store 以可变对象模拟，按用例切换登录态（参考 MePanel.test）
  session: {
    status: "authed",
    me: null as unknown,
    loadMe: vi.fn(),
  },
  listAssistantCertifications: vi.fn(),
  listCourses: vi.fn(),
  fetchUserAnswers: vi.fn(),
}));

vi.mock("@/shared/stores/session-store", () => ({
  useSessionStore: (selector: (state: typeof mocks.session) => unknown) =>
    selector(mocks.session),
}));

vi.mock("@/api/users", () => ({
  listAssistantCertifications: mocks.listAssistantCertifications,
  reviewAssistantCertification: vi.fn(),
  fetchUserAnswers: mocks.fetchUserAnswers,
}));
vi.mock("@/api/courses", () => ({
  listCourses: mocks.listCourses,
}));

import type { UserMe } from "@/shared/types/auth";

import { TeacherWorkspaceView } from "./TeacherWorkspaceView";

const MOCK_ME: UserMe = {
  id: 7,
  username: "王老师",
  email: "wang@campus.edu",
  role: "teacher",
  status: "active",
  ban_reason: null,
  identity_type: "undergraduate",
  assistant_cert_status: "none",
  reputation_score: 120,
  bio: null,
  avatar_url: null,
  created_at: "2026-09-01T10:00:00+08:00",
};

function linkByLabel(label: RegExp): HTMLAnchorElement {
  return screen.getByRole("link", { name: label }) as HTMLAnchorElement;
}

function tabByName(name: string): HTMLButtonElement {
  return screen.getByRole("tab", { name }) as HTMLButtonElement;
}

describe("TeacherWorkspaceView", () => {
  beforeEach(() => {
    mocks.session.status = "authed";
    mocks.session.me = { ...MOCK_ME };
    mocks.listAssistantCertifications.mockReset().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
    });
    mocks.listCourses.mockReset().mockResolvedValue({
      items: [],
      total: 3,
      page: 1,
      page_size: 1,
    });
    mocks.fetchUserAnswers.mockReset().mockResolvedValue({
      items: [],
      total: 12,
      page: 1,
      page_size: 10,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // 回归：本页不再自行 loadMe。守卫按 status 卸载子页面，子页面若同时 loadMe 会把 status
  // 退回 loading → 子页面反复重挂 + 无限请求（登录态由 app/teacher/layout 的 TeacherGuard 统一探测）
  it("不自行探测登录态（交给 TeacherGuard）", () => {
    render(<TeacherWorkspaceView />);

    expect(mocks.session.loadMe).not.toHaveBeenCalled();
  });

  it("登录态渲染真实课程/回答总数，无聚合接口的指标继续占位", async () => {
    render(<TeacherWorkspaceView />);

    const courseLink = linkByLabel(/我的课程/);
    expect(courseLink.getAttribute("href")).toBe("/teacher/courses");
    expect(linkByLabel(/待处理工单/).getAttribute("href")).toBe("/teacher/moderation");
    expect(linkByLabel(/待审核问题/).getAttribute("href")).toBe("/teacher/certify");
    expect(linkByLabel(/我的回答/).getAttribute("href")).toBe("/users/7");
    expect(await within(courseLink).findByText("3")).toBeTruthy();
    expect(within(linkByLabel(/我的回答/)).getByText("12")).toBeTruthy();
    expect(mocks.listCourses).toHaveBeenCalledWith({ mine: true, page: 1, page_size: 1 });
    expect(mocks.fetchUserAnswers).toHaveBeenCalledWith(7, 1);
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("单个指标请求失败只让该卡显示“—”，不拖垮其他真实指标", async () => {
    mocks.listCourses.mockRejectedValue(new Error("课程统计失败"));
    render(<TeacherWorkspaceView />);

    expect(await within(linkByLabel(/我的回答/)).findByText("12")).toBeTruthy();
    expect(within(linkByLabel(/我的课程/)).getByText("—")).toBeTruthy();
    expect(screen.getByText("我的课程")).toBeTruthy();
    expect(screen.getByText("教师端工单接口尚未开放")).toBeTruthy();
  });

  it("切换登录账号时不沿用上一账号的指标数字", async () => {
    const view = render(<TeacherWorkspaceView />);
    expect(await within(linkByLabel(/我的课程/)).findByText("3")).toBeTruthy();
    expect(within(linkByLabel(/我的回答/)).getByText("12")).toBeTruthy();

    mocks.listCourses.mockReturnValue(new Promise(() => {}));
    mocks.fetchUserAnswers.mockReturnValue(new Promise(() => {}));
    mocks.session.me = { ...MOCK_ME, id: 8, username: "李老师" };
    view.rerender(<TeacherWorkspaceView />);

    expect(screen.queryByText("3")).toBeNull();
    expect(screen.queryByText("12")).toBeNull();
    expect(screen.getAllByText("—")).toHaveLength(4);
  });

  it("工单区 Tab 为组件状态切换：默认待处理，可切历史；空态文案固定", () => {
    render(<TeacherWorkspaceView />);

    expect(tabByName("待处理").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(tabByName("历史"));
    expect(tabByName("历史").getAttribute("aria-selected")).toBe("true");
    expect(tabByName("待处理").getAttribute("aria-selected")).toBe("false");
    // 治理接口仅管理员可调：教师端两个 Tab 下均为同一空态
    expect(screen.getByText("教师端工单接口尚未开放")).toBeTruthy();
  });

  it("动态调课区渲染空态", () => {
    render(<TeacherWorkspaceView />);

    expect(screen.getByText("暂无调课通知")).toBeTruthy();
  });

  // 评审要求：助教认证审核挪到所有教师都能到的工作台（后端 list/review 只要求 teacher 角色，与具体课程无关）
  it("工作台底部提供助教认证审核入口（教师）", async () => {
    render(<TeacherWorkspaceView />);

    expect(await screen.findByText("助教板块 · 认证审核")).toBeTruthy();
    expect(mocks.listAssistantCertifications).toHaveBeenCalledWith({
      status: "pending",
      page: 1,
      page_size: 20,
    });
  });

  it("管理员继承助教资格审核入口", async () => {
    mocks.session.me = { ...MOCK_ME, role: "admin" };
    render(<TeacherWorkspaceView />);

    await screen.findByText("暂无调课通知");
    expect(await screen.findByText("助教板块 · 认证审核")).toBeTruthy();
    expect(mocks.listAssistantCertifications).toHaveBeenCalled();
  });

  it("guest 态渲染登录引导，不渲染指标卡", () => {
    mocks.session.status = "guest";
    mocks.session.me = null;
    render(<TeacherWorkspaceView />);

    expect(screen.getByText("登录后查看教师工作台")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /我的课程/ })).toBeNull();
    expect(mocks.listCourses).not.toHaveBeenCalled();
    expect(mocks.fetchUserAnswers).not.toHaveBeenCalled();
  });

  it("加载态只渲染与四张指标卡对应的四个骨架", () => {
    mocks.session.status = "loading";
    mocks.session.me = null;
    const { container } = render(<TeacherWorkspaceView />);

    expect(screen.getByText("正在加载教师工作台")).toBeTruthy();
    const metricGrid = container.querySelector(".grid.grid-cols-2");
    expect(metricGrid?.querySelectorAll(".co-skeleton")).toHaveLength(4);
    expect(container.querySelectorAll(".co-skeleton")).toHaveLength(6);
    expect(screen.queryByRole("link", { name: /我的课程/ })).toBeNull();
    expect(mocks.listCourses).not.toHaveBeenCalled();
    expect(mocks.fetchUserAnswers).not.toHaveBeenCalled();
  });
});
