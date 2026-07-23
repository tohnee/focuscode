# ADR-0004：Alpha 使用 File FactStore，生产迁移 PostgreSQL

- 状态：Accepted with exit condition
- 日期：2026-07-19

## Context

首条垂直切片需要可检查的 Event/Checkpoint 事实，但立即建设 PostgreSQL、queue、outbox 和
部署基础设施会延迟 Kernel/Action/Verifier 语义验证。

## Decision

Alpha 使用 JSONL Event + atomic Checkpoint 的 FileFactStore，实现 optimistic version 和
进程间 append lock。Kernel 只依赖 FactPort。

## Exit condition

出现第二 Worker、远程 Action、Pilot 数据或 crash-recovery Gate 时，必须实现 PostgreSQL
16 adapter、transactional outbox、lease/fencing 和 durable Action receipt，File adapter
只保留给单元测试/本地模式。

## Consequences

- 本地零基础设施且事件可读；
- 不能声明数据库级 durability；
- 不能安全处理 action-started/receipt-missing；
- 接口替换不修改 Kernel。
