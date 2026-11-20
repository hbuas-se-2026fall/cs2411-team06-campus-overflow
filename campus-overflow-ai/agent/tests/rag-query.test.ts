// 查询拆解：分隔符、连接词、去重与数量上限。
import { describe, expect, it } from "vitest";

import { decomposeQuery, MAX_SUB_QUERIES } from "../src/knowledge/rag/query.js";

describe("查询拆解", () => {
  it("按问号、分号和连接词拆分并保留顺序", () => {
    expect(decomposeQuery("死锁怎么预防？如何检测；以及事务隔离级别"))
      .toEqual(["死锁怎么预防", "如何检测", "事务隔离级别"]);
  });

  it("不拆“和/与”，避免拆散同一信息需求", () => {
    expect(decomposeQuery("死锁和事务隔离的区别")).toEqual(["死锁和事务隔离的区别"]);
  });

  it("去重并限制子问题数量", () => {
    expect(decomposeQuery("死锁？死锁？调度？配额？索引？")).toHaveLength(MAX_SUB_QUERIES);
  });

  it("空查询返回空数组，单问题原样返回", () => {
    expect(decomposeQuery("   ")).toEqual([]);
    expect(decomposeQuery("死锁怎么预防")).toEqual(["死锁怎么预防"]);
  });

  it("过滤拆分后的单字残片", () => {
    expect(decomposeQuery("死锁？。？如何检测")).toEqual(["死锁", "如何检测"]);
  });
});
