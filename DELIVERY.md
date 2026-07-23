# FocusCode 0.4.0-beta.2 交付说明

## 交付结论

本版本是针对 v0.3 Alpha1 全源码和 Pi 0.80.10 的 Apple-to-Apple Harness 审查与修复版。
`pnpm release:check` 已通过，CLI npm tarball 可洁净安装并完成本地流式两轮 Tool loop。

当前定位是“企业预生产 Beta”：代码已具备 fail-closed 企业配置，但在完成真实 Provider、
Docker/runsc/VM、扩展 containment 和同模型 Pi A/B 前，不应标记为生产 GA 或宣称总体优于 Pi。

## 主要入口

- 产品与安装：[README.md](README.md)
- 当前架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Pi 逐项审查：[docs/V0.4_PI_APPLE_TO_APPLE_REVIEW.md](docs/V0.4_PI_APPLE_TO_APPLE_REVIEW.md)
- 企业接入与 Gate：[docs/V0.4_ENTERPRISE_DEPLOYMENT.md](docs/V0.4_ENTERPRISE_DEPLOYMENT.md)
- 开发进度：[docs/DEVELOPMENT_STATUS.md](docs/DEVELOPMENT_STATUS.md)
- 测试报告：[docs/TEST_REPORT.md](docs/TEST_REPORT.md)
- 安全边界：[SECURITY.md](SECURITY.md)

## 验证结果

| Gate                                      | 结果                              |
| ----------------------------------------- | --------------------------------- |
| 23 workspace projects build               | PASS                              |
| 26 test files / 93 tests                  | PASS                              |
| Statements / Branches / Functions / Lines | 77.53% / 65.24% / 82.75% / 81.85% |
| Architecture + Prettier                   | PASS                              |
| Audited Kernel demo                       | PASS                              |
| Conversational Agent demo                 | PASS，2 model rounds              |
| npm clean install + installed Tool loop   | PASS，2 model rounds              |

npm tarball：`reports/npm/focuscode-cli-0.4.0-beta.2.tgz`  
SHA-256：`2f819898ecb804afb7177ae0b664d25a973cc1a7b2fcc6c6380b9b2106eeb9bf`

## 安装

```bash
npm install --global ./focuscode-cli-0.4.0-beta.2.tgz
focuscode --version
focuscode --list-providers
focuscode sandbox doctor --kind auto
```

企业初始化、审计 key、镜像 digest 和 readiness 操作见企业接入文档。

## 尚未关闭的上线 Gate

1. Kimi/Qwen/GLM/DeepSeek/MiniMax 的真实凭据 contract suite；
2. 目标平台 Docker/runsc 攻击矩阵和 disposable VM lifecycle；
3. Extension 独立 process/WASI capability host；
4. Conversational Agent 与 Focus Kernel 的唯一 Policy/Grant/Receipt 主链；
5. Session WAL/migration/repair 与未知副作用 reconciliation；
6. Pi 同模型、同预算、同 Repo 的 10–30 项 A/B；
7. OIDC/RBAC、Secret/Egress Broker、SBOM/provenance 和 SLO。
