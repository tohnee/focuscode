# FocusCode 0.4.0-beta.1 Delivery Manifest

交付日期：2026-07-19

## 制品

| 文件                                         | 用途                                                                        |          大小 |
| -------------------------------------------- | --------------------------------------------------------------------------- | ------------: |
| `FocusCode-v0.4.0-beta.1-source.tar.gz`      | 完整 monorepo 源码、测试、文档、lockfile、源码 SHA manifest 与 npm 验证结果 | 416,865 bytes |
| `focuscode-cli-0.4.0-beta.1.tgz`             | 可由 npm 全局安装的 standalone CLI                                          | 138,076 bytes |
| `FocusCode-v0.4-Pi-Apple-to-Apple-Review.md` | Pi 0.80.10 逐项取证、六项差距、遗漏与路线图                                 |  20,178 bytes |
| `FocusCode-v0.4-Enterprise-Deployment.md`    | 五系 Provider、OIDC、企业配置与上线 Gate                                    |   8,259 bytes |
| `FocusCode-v0.4-Test-Report.md`              | 自动化范围、覆盖率、限制和下一验收矩阵                                      |   5,227 bytes |
| `FocusCode-v0.4-Delivery-Notes.md`           | 快速交付索引                                                                |   2,652 bytes |
| `FocusCode-v0.4.0-beta.1-SHA256SUMS.txt`     | 上述制品 SHA-256                                                            |             — |

## 已验证

- `pnpm release:check`：PASS；
- 23 workspace projects 构建；
- 26 个测试文件、89 项测试；
- Statements 77.46%、Branches 65.12%、Functions 82.73%、Lines 81.81%；
- Audited Kernel demo：PASS；
- Conversational Agent 本地流式 2-round Tool loop：PASS；
- npm pack → 禁脚本洁净安装 → 安装后 2-round Tool loop：PASS；
- 源码 tarball 在新的目录解包 → frozen lockfile 安装 → 23-project build：PASS；
- 源码 archive 不包含 `node_modules`、`dist`、临时状态和 coverage HTML。

## 状态边界

这是企业预生产 Beta，不是生产 GA。真实五家 Provider、Docker/runsc/VM、Extension
containment、唯一 Policy/Receipt 主链和 Pi 同条件 Repo A/B 仍是上线 Gate。
