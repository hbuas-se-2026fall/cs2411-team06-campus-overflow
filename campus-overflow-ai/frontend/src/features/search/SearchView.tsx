"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { fetchCourses } from "@/api/courses";
import { search } from "@/api/search";
import { listTags } from "@/api/tags";
import { CourseCard } from "@/features/courses/CourseCard";
import {
  createdFromForRange,
  QuestionFilterBar,
  type QuestionFilters,
  type QuestionTimeRange,
} from "@/features/home/QuestionFilterBar";
import { QuestionCard } from "@/features/questions/QuestionCard";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Pagination,
  TagChip,
} from "@/shared/components";
import { useAsyncData } from "@/shared/hooks/useAsyncData";
import { usePagedList } from "@/shared/hooks/usePagedList";
import type { Paged } from "@/shared/types/common";
import type { QuestionListItem } from "@/shared/types/question";
import type { SearchParams } from "@/api/search";

import {
  clearSearchHistory,
  loadSearchHistory,
  removeSearchKeyword,
  saveSearchKeyword,
} from "./history";

const PAGE_SIZE = 10;

// 空关键词不发请求：返回空页，让页面走"输入关键词"引导空态
function fetchSearchPage(query: SearchParams): Promise<Paged<QuestionListItem>> {
  if (!query.q) {
    return Promise.resolve({
      items: [],
      total: 0,
      page: query.page ?? 1,
      page_size: query.page_size ?? PAGE_SIZE,
    });
  }
  return search(query);
}

interface SearchQuery extends QuestionFilters {
  keyword: string;
  page: number;
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

// URL 参数解析：q 为主（顶栏搜索框写入，spec「发现」），keyword 为兼容别名；默认值不写入 URL
function parseSearchQuery(params: URLSearchParams): SearchQuery {
  const keyword = (params.get("q") ?? params.get("keyword") ?? "").trim();
  return {
    keyword,
    courseId: parsePositiveInt(params.get("course_id")),
    tagId: parsePositiveInt(params.get("tag_id")),
    sort: params.get("sort") === "hot" ? "hot" : "latest",
    unresolved: params.get("unresolved") === "1" || params.get("unresolved") === "true",
    within: parseTimeRange(params.get("within")),
    page: parsePositiveInt(params.get("page")) ?? 1,
  };
}

function parseTimeRange(raw: string | null): QuestionTimeRange {
  return raw === "day" || raw === "week" || raw === "month" ? raw : "any";
}

function buildSearchPath(query: SearchQuery): string {
  const params = new URLSearchParams();
  if (query.keyword) params.set("q", query.keyword);
  if (query.courseId !== undefined) params.set("course_id", String(query.courseId));
  if (query.tagId !== undefined) params.set("tag_id", String(query.tagId));
  if (query.sort === "hot") params.set("sort", "hot");
  if (query.unresolved) params.set("unresolved", "1");
  if (query.within !== "any") params.set("within", query.within);
  if (query.page > 1) params.set("page", String(query.page));
  const queryString = params.toString();
  return queryString ? `/search?${queryString}` : "/search";
}

function querySignature(query: SearchQuery): string {
  return [
    query.keyword,
    query.courseId ?? "",
    query.tagId ?? "",
    query.sort,
    query.unresolved ? "1" : "0",
    query.within,
    query.page,
  ].join("|");
}

function toSearchParams(query: SearchQuery): SearchParams {
  return {
    q: query.keyword,
    course_id: query.courseId,
    tag_id: query.tagId,
    sort: query.sort,
    unresolved: query.unresolved ? true : undefined,
    created_from: createdFromForRange(query.within),
  };
}

// 搜索记录页主组件（§2.17）：搜索框（自动聚焦/保留关键词）+ 历史 chips + 结果区（问题卡+分页）
// 关键词与页码写 URL（?q=&page=），刷新可回填；列表同步统一由 URL 变化驱动
// （深链页码由下方 URL 同步 effect 在挂载时应用，server 壳无需回传 page）
export function SearchView({ initialKeyword }: { initialKeyword: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [inputValue, setInputValue] = useState(initialKeyword);
  // 已应用的完整查询；本地提交先更新它，避免等待 router 异步回写 URL。
  const [activeQuery, setActiveQuery] = useState<SearchQuery>(() =>
    parseSearchQuery(searchParams),
  );
  // 历史只在客户端挂载后读取，避免 SSR/CSR 首帧不一致
  const [history, setHistory] = useState<string[]>([]);
  const courseMatches = useAsyncData(async () => {
    const keyword = activeQuery.keyword.trim();
    if (!keyword) return null;
    return fetchCourses({ page: 1, page_size: 6, keyword });
  }, [activeQuery.keyword]);
  const tagMatches = useAsyncData(async () => {
    const keyword = activeQuery.keyword.trim();
    if (!keyword) return null;
    return listTags({ keyword });
  }, [activeQuery.keyword]);

  const {
    items,
    total,
    page,
    pageSize,
    isLoading,
    error,
    reload,
    setParams,
    setPage,
  } = usePagedList(
    fetchSearchPage,
    toSearchParams(parseSearchQuery(searchParams)),
    PAGE_SIZE,
  );

  // appliedRef 记录已应用的查询签名：内部提交先行标记，URL effect 到来时跳过，避免双拉
  const appliedRef = useRef<string>(
    querySignature({ ...parseSearchQuery(searchParams), page: 1 }),
  );

  useEffect(() => {
    let active = true;
    // 先让出同步执行栈再 setState（同 QuestionForm 草稿恢复：避免 effect 内级联渲染）；
    // 不能用 useState 惰性初始化，SSR 预渲染时 window 不存在
    void Promise.resolve().then(() => {
      if (active) setHistory(loadSearchHistory(window.localStorage));
    });
    return () => {
      active = false;
    };
  }, []);

  // URL → 列表同步：仅响应外部变化（浏览器回退/前进、顶栏搜索）
  useEffect(() => {
    const next = parseSearchQuery(searchParams);
    const signature = querySignature(next);
    if (signature === appliedRef.current) return;
    appliedRef.current = signature;
    setActiveQuery(next);
    if (next.page > 1) {
      // setParams + setPage 同批提交，只触发一次重取（深链直达第 N 页）
      setParams(toSearchParams(next));
      setPage(next.page);
    } else {
      setParams(toSearchParams(next)); // setParams 内部会重置回第 1 页
    }
  }, [searchParams, setParams, setPage]);

  // 外部关键词变化同步回输入框（提交写入的值与本轮一致，无感）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 先让出同步执行栈：避免在 effect 中同步 setState（react-hooks/set-state-in-effect）
      await Promise.resolve();
      if (!cancelled) setInputValue(activeQuery.keyword);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeQuery.keyword]);

  const handleSearch = useCallback(
    (rawKeyword: string) => {
      const keyword = rawKeyword.trim();
      if (!keyword) return;
      // 新搜索先写历史（置顶去重），再应用查询并写 URL
      setHistory(saveSearchKeyword(window.localStorage, keyword));
      const next = { ...activeQuery, keyword, page: 1 };
      appliedRef.current = querySignature(next);
      setActiveQuery(next);
      setParams(toSearchParams(next));
      router.replace(buildSearchPath(next));
    },
    [activeQuery, router, setParams],
  );

  const handlePageChange = useCallback(
    (nextPage: number) => {
      const next = { ...activeQuery, page: nextPage };
      appliedRef.current = querySignature(next);
      setActiveQuery(next);
      setPage(nextPage);
      router.replace(buildSearchPath(next));
    },
    [activeQuery, router, setPage],
  );

  const handleFiltersChange = useCallback(
    (patch: Partial<QuestionFilters>) => {
      const next = { ...activeQuery, ...patch, page: 1 };
      if (!next.keyword) return;
      appliedRef.current = querySignature(next);
      setActiveQuery(next);
      setParams(toSearchParams(next));
      router.replace(buildSearchPath(next));
    },
    [activeQuery, router, setParams],
  );

  const handleAsk = useCallback(() => {
    // 空态"直接提问"引导；未登录由 src/proxy.ts 拦截跳登录
    router.push("/questions/new");
  }, [router]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    handleSearch(inputValue);
  }

  const hasKeyword = activeQuery.keyword !== "";
  const showCourseMatches =
    hasKeyword &&
    !courseMatches.isLoading &&
    courseMatches.error === null &&
    (courseMatches.data?.items.length ?? 0) > 0;
  const showTagMatches =
    hasKeyword &&
    !tagMatches.isLoading &&
    tagMatches.error === null &&
    (tagMatches.data?.items.length ?? 0) > 0;
  const hasRelated = showCourseMatches || showTagMatches;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[22px] font-semibold text-ink">搜索记录</h1>

      {/* 搜索框：自动聚焦、保留关键词（§2.17） */}
      <form role="search" onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          placeholder="搜索问题、课程或标签"
          aria-label="全站搜索"
          autoFocus
          className="co-focusable h-10 w-full max-w-[520px] rounded-md border border-line bg-canvas px-3 text-[14px] text-ink transition-colors duration-150 ease-standard placeholder:text-ink-subtle hover:border-ink-subtle focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
        <Button type="submit">搜索</Button>
      </form>

      {hasKeyword ? (
        <QuestionFilterBar
          filters={activeQuery}
          onChange={handleFiltersChange}
          onAsk={handleAsk}
        />
      ) : null}

      {showCourseMatches ? (
        <section aria-label="相关课程" className="flex flex-col gap-3">
          <h2 className="text-[16px] font-semibold text-ink">
            相关课程
            <span className="ml-2 text-[12px] font-normal text-ink-subtle">
              共 {courseMatches.data?.total ?? 0} 门
            </span>
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {courseMatches.data?.items.map((course) => (
              <CourseCard key={course.id} course={course} />
            ))}
          </div>
        </section>
      ) : null}

      {showTagMatches ? (
        <section aria-label="相关标签" className="flex flex-col gap-2">
          <h2 className="text-[16px] font-semibold text-ink">相关标签</h2>
          <div className="flex flex-wrap gap-2">
            {tagMatches.data?.items.map((tag) => (
              <Link
                key={tag.id}
                href={`/tags/${tag.id}`}
                aria-label={`标签 ${tag.name}`}
                className="co-focusable rounded-full"
              >
                <TagChip label={tag.name} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* 搜索历史 chips：逐条可删 + 一键清空；历史为空隐藏整块 */}
      {history.length > 0 ? (
        <section
          aria-label="搜索历史"
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-[13px] text-ink-muted">搜索历史</span>
          {history.map((keyword) => (
            <span
              key={keyword}
              className="inline-flex items-center rounded-full border border-line bg-panel"
            >
              <button
                type="button"
                onClick={() => handleSearch(keyword)}
                className="co-focusable cursor-pointer rounded-l-full py-1 pl-3 pr-1.5 text-[13px] text-ink transition-colors duration-150 ease-standard hover:text-brand"
              >
                {keyword}
              </button>
              <button
                type="button"
                aria-label={`删除搜索历史 ${keyword}`}
                onClick={() => setHistory(removeSearchKeyword(window.localStorage, keyword))}
                className="co-focusable cursor-pointer rounded-r-full py-1 pl-0.5 pr-2.5 text-[12px] text-ink-subtle transition-colors duration-150 ease-standard hover:text-danger"
              >
                ×
              </button>
            </span>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setHistory(clearSearchHistory(window.localStorage))}>
            清空历史
          </Button>
        </section>
      ) : null}

      {/* TODO(AI 二期)：搜索结果 AI 摘要与智能推荐槽位，随 Agent 服务开放 */}
      <section aria-label="搜索结果" className="flex flex-col gap-4">
        {!hasKeyword ? (
          <EmptyState
            title="输入关键词，搜索问题、课程和标签"
            description="输入课程名、知识点或报错信息，一次查看相关问答、课程和标签。"
            actionLabel="直接提问"
            onAction={handleAsk}
          />
        ) : isLoading ? (
          <LoadingSkeleton variant="list" count={5} />
        ) : error !== null ? (
          <ErrorState message={error} onRetry={reload} />
        ) : items.length === 0 ? (
          <EmptyState
            title={hasRelated ? "没有相关问题" : "未找到相关内容，换个关键词试试"}
            description={
              hasRelated
                ? "上方已有相关课程或标签，你也可以直接发起提问。"
                : "可以简化关键词再搜一次，或直接发起提问让同学和老师来解答。"
            }
            actionLabel="直接提问"
            onAction={handleAsk}
          />
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {items.map((question) => (
                <li key={question.id}>
                  <QuestionCard question={question} />
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] text-ink-subtle">共 {total} 条</p>
              <Pagination page={page} pageSize={pageSize} total={total} onChange={handlePageChange} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
