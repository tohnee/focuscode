# ADR-0003：ActionIntent、Grant、Receipt 与 Effect Ledger

- 状态：Accepted for Alpha
- 日期：2026-07-19

## Context

模型的工具调用不是权限。单次“低风险”动作序列可能累积成越权写入、数据外流或供应链
变化，只做一次 allow/deny 无法表达组合风险。

## Decision

模型提交 ActionIntent；Action Runtime 校验 Tool digest、task identity、Policy 和累计
Effect Ledger，随后创建短期 CapabilityGrant。Backend 执行后返回 observed EffectReceipt。

Alpha Grant 暂未独立持久化，Effect Ledger 位于本地 runtime；正式 H1 必须用 durable
Action journal 和 workload identity 替换。

## Consequences

- 模型无法自授权限；
- Approval 可以显示具体和累计效果；
- Tool schema 变化会 fail closed；
- 需要 durable reconciliation 才能安全支持非幂等远程动作。
