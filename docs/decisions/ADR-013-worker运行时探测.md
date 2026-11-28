# ADR-013：worker 数改为运行时探测

- 状态：accepted
- 日期：2026-11-28
- 决策人：用户
- 取代：ADR-012 第 1 条中“worker 数固定封顶 4”的部分

## 背景

ADR-012 使用 `min(4, CPU//2, 内存GB)`，隐含了 4C4G 的目标机型。用户要求不写死机型参数，改为像交叉编译探测可用核数一样，在启动时读取真实 CPU、内存与数据库连接预算。

## 决策

1. 启动时探测可用 CPU（`os.sched_getaffinity`，回退 `os.cpu_count`）与内存上限（cgroup v2 `memory.max` / v1 `memory.limit_in_bytes`）。
2. worker 数：`workers = max(1, min(cpus, memory_gb, DB_CONNECTION_BUDGET // (pool_size + max_overflow)))`。
3. `DB_CONNECTION_BUDGET` 默认 100，为 MySQL 默认 `max_connections=151` 留出迁移与运维余量；`WORKER_MAX>0` 时可再收紧；`WEB_CONCURRENCY` 显式设置时跳过计算。
4. 每 worker 连接池保持 10+10；扩容 worker 前必须先确认数据库连接预算。
5. 计算逻辑放在 `backend/app/core/workers.py` 并有单测，入口脚本只负责探测环境并调用。

## 后果

- 正面：同一镜像可在 2C2G、4C4G、16C32G 等环境按实际资源启动，不再依赖机型假设。
- 负面：worker 数受数据库预算限制，CPU 核多但预算低时不会盲目扩容；需要运维理解 `DB_CONNECTION_BUDGET`。
- 4C4G、预算 100 时得到 4 worker、总连接 80；16C15G、预算 100 时得到 5 worker。
- 1000/10000 并发不属于当前同步栈的容量范围：1000 并发下线程池与连接池饱和，10000 并发时监听队列溢出（连接拒绝）。需要异步化、排队与水平扩容，另行立项。
