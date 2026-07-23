# ADR-0002：Atomic Model Turn

- 状态：Accepted for Alpha
- 日期：2026-07-19

## Context

流式模型输出可能在 JSON、UTF-8、转义或工具参数中间断开。如果边接收边执行，截断会把
不完整意图变成真实副作用。

## Decision

Transport 收集完整 response 与 finish reason；Atomic Parser 只输出 `complete`、`invalid`、
`truncated` 或 `provider_error`。只有 canonical schema 完整通过后，Kernel 才追加
`ModelDecisionAccepted` 并创建 ActionIntent。

允许一次纯确定性 fence/balanced-object 提取，不补写语义字段，不对 partial tool call 执行。

## Consequences

- 增加首动作时延和 buffer 内存；
- stream/non-stream 能统一比较；
- 截断副作用为零可以作为硬安全测试；
- 真正 token streaming UI 只能显示未承诺的 provisional text。
