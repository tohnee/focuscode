# ADR-0001：Focus Kernel 与四端口边界

- 状态：Accepted for Alpha
- 日期：2026-07-19

## Context

Provider SDK 或既有 Agent Harness 如果成为领域内核，Task、状态、恢复、权限和资产会与
单一模型/厂商绑定。SDK 类型隔离不能提供语义可迁移性。

## Decision

Focus Kernel 独立拥有状态机、Turn 事务、预算和 Checkpoint，只依赖 `DecisionPort`、
`EffectPort`、`FactPort`、`VerifyPort`。Provider、文件、进程、协议和存储实现位于边缘。

## Consequences

- Scripted Model 和真实模型使用相同 Kernel；
- Action backend/存储可替换；
- Kernel 不能利用未进入 canonical ABI 的 Provider 私有状态；
- Native Harness 的高阶能力未来通过受限 Capsule，而不是污染 Kernel。
