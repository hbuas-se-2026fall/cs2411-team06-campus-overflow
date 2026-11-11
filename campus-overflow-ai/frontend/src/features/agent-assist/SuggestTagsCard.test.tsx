import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";

const mocks = vi.hoisted(() => ({
  suggestTags: vi.fn(),
  bindQuestionTags: vi.fn(),
}));

vi.mock("@/api/agent-assist", () => ({
  JUST_CREATED_QUESTION_KEY: "co_just_created_question",
  suggestTags: mocks.suggestTags,
}));
vi.mock("@/api/questions", () => ({
  bindQuestionTags: mocks.bindQuestionTags,
}));

import { SuggestTagsCard } from "./SuggestTagsCard";

const KEY = "co_just_created_question";
const RESULT = {
  tags: [
    {
      name: "动态规划",
      reason: "问题正文包含状态转移推导",
      confidence: 0.92,
      tagId: 8,
    },
    {
      name: "算法",
      reason: "问题属于算法题",
      confidence: 0.81,
    },
  ],
  basisNote: "依据为站内标签词表与问题文本语义匹配。",
};

function renderCard(
  onApplied: () => void = vi.fn(),
  existingTags: Array<{ id: number; name: string }> = [],
) {
  render(
    <SuggestTagsCard
      questionId={55}
      questionTitle="动态规划状态转移怎么推导"
      questionBody="我不理解状态转移方程"
      courseId={1}
      existingTags={existingTags}
      onApplied={onApplied}
    />,
  );
  return onApplied;
}

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.suggestTags.mockReset().mockResolvedValue(RESULT);
  mocks.bindQuestionTags.mockReset().mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe("SuggestTagsCard", () => {
  it("只在本浏览器刚创建的问题上请求建议，展示依据但默认不勾选", async () => {
    window.sessionStorage.setItem(KEY, "55");
    renderCard();

    expect(await screen.findByText("动态规划")).toBeTruthy();
    expect(mocks.suggestTags).toHaveBeenCalledWith(
      {
        questionTitle: "动态规划状态转移怎么推导",
        questionBody: "我不理解状态转移方程",
        courseId: 1,
      },
      expect.any(AbortSignal),
    );
    expect(screen.getByText("建议依据：依据为站内标签词表与问题文本语义匹配。")).toBeTruthy();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect((checkbox as HTMLInputElement).checked).toBe(false);
    }
    expect(
      (screen.getByRole("button", { name: "确认添加（0）" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mocks.bindQuestionTags).not.toHaveBeenCalled();
  });

  it("用户逐条勾选并确认后才写入标签，成功后清标记并通知刷新", async () => {
    window.sessionStorage.setItem(KEY, "55");
    const onApplied = renderCard();
    await screen.findByText("动态规划");

    fireEvent.click(screen.getByRole("checkbox", { name: /动态规划/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认添加（1）" }));

    await waitFor(() => expect(mocks.bindQuestionTags).toHaveBeenCalledWith(55, ["动态规划"]));
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(screen.queryByLabelText("标签建议")).toBeNull();
  });

  it("标记不属于当前问题时不请求也不渲染", async () => {
    window.sessionStorage.setItem(KEY, "54");
    renderCard();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.suggestTags).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("标签建议")).toBeNull();
  });

  it("跳过只清当前浏览器的建议标记，不写标签", async () => {
    window.sessionStorage.setItem(KEY, "55");
    renderCard();
    await screen.findByText("动态规划");

    fireEvent.click(screen.getByRole("button", { name: "跳过" }));

    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(screen.queryByLabelText("标签建议")).toBeNull();
    expect(mocks.bindQuestionTags).not.toHaveBeenCalled();
  });

  it("写入失败时保留勾选与标记，并提示稍后重试", async () => {
    window.sessionStorage.setItem(KEY, "55");
    mocks.bindQuestionTags.mockRejectedValue(new Error("network down"));
    renderCard();
    await screen.findByText("动态规划");

    fireEvent.click(screen.getByRole("checkbox", { name: /动态规划/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认添加（1）" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "标签添加失败，可在详情页稍后重试",
    );
    expect(window.sessionStorage.getItem(KEY)).toBe("55");
    expect(
      (screen.getByRole("checkbox", { name: /动态规划/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("400 等可解释失败透传后端中文提示", async () => {
    window.sessionStorage.setItem(KEY, "55");
    mocks.bindQuestionTags.mockRejectedValue(new ApiError(400, "该标签已绑定"));
    renderCard();
    await screen.findByText("动态规划");

    fireEvent.click(screen.getByRole("checkbox", { name: /动态规划/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认添加（1）" }));

    expect((await screen.findByRole("alert")).textContent).toContain("该标签已绑定");
  });

  it("提交期间锁定确认和跳过，禁止重复写标签或关闭卡片", async () => {
    window.sessionStorage.setItem(KEY, "55");
    let finishBind!: (value: unknown) => void;
    mocks.bindQuestionTags.mockReturnValue(
      new Promise((resolve) => {
        finishBind = resolve;
      }),
    );
    renderCard();
    await screen.findByText("动态规划");

    fireEvent.click(screen.getByRole("checkbox", { name: /动态规划/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认添加（1）" }));

    const applying = await screen.findByRole("button", { name: "添加中…" });
    expect((applying as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: /动态规划/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    const skip = screen.getByRole("button", { name: "跳过" }) as HTMLButtonElement;
    expect(skip.disabled).toBe(true);
    fireEvent.click(skip);
    expect(window.sessionStorage.getItem(KEY)).toBe("55");
    expect(mocks.bindQuestionTags).toHaveBeenCalledTimes(1);

    finishBind({});
  });

  it("标签已写入后即使刷新回调异常也不显示假失败", async () => {
    window.sessionStorage.setItem(KEY, "55");
    renderCard(() => {
      throw new Error("refresh failed");
    });
    await screen.findByText("动态规划");

    fireEvent.click(screen.getByRole("checkbox", { name: /动态规划/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认添加（1）" }));

    await waitFor(() => expect(window.sessionStorage.getItem(KEY)).toBeNull());
    expect(screen.queryByLabelText("标签建议")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("过滤问题已有标签和重复建议，避免整批绑定被 400 拒绝", async () => {
    window.sessionStorage.setItem(KEY, "55");
    mocks.suggestTags.mockResolvedValue({
      tags: [
        RESULT.tags[0],
        RESULT.tags[1],
        { name: "算法", reason: "重复候选", confidence: 0.7 },
      ],
      basisNote: RESULT.basisNote,
    });
    renderCard(vi.fn(), [{ id: 8, name: "动态规划" }]);

    expect(await screen.findByText("算法")).toBeTruthy();
    expect(screen.queryByText("动态规划")).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("按问题剩余标签空位限制 tagCount，避免确认后超过五个", async () => {
    window.sessionStorage.setItem(KEY, "55");
    renderCard(vi.fn(), [
      { id: 1, name: "课程标签" },
      { id: 2, name: "技术标签" },
      { id: 3, name: "自定义一" },
      { id: 4, name: "自定义二" },
    ]);

    await screen.findByText("动态规划");
    expect(mocks.suggestTags).toHaveBeenCalledWith(
      expect.objectContaining({ tagCount: 1 }),
      expect.any(AbortSignal),
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("问题已有五个标签时不请求建议", async () => {
    window.sessionStorage.setItem(KEY, "55");
    renderCard(vi.fn(), [
      { id: 1, name: "课程标签" },
      { id: 2, name: "技术标签" },
      { id: 3, name: "自定义一" },
      { id: 4, name: "自定义二" },
      { id: 5, name: "自定义三" },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.suggestTags).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("标签建议")).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });
});
