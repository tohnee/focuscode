# Security

## v0.4 Beta posture

FocusCode `0.4.0-beta.1` 已提供企业 fail-closed policy、可验证审计与真实隔离驱动，但安全性
仍取决于部署机的 Docker/gVisor/VM、身份系统和组织策略。Beta 不是生产安全认证。

## 默认值

- Sandbox `auto`：gVisor → Docker → fail，`allowHostFallback=false`；
- 容器默认断网、read-only root、tmpfs、cap-drop、no-new-privileges、PID/CPU/内存限制；
- 项目 Instructions/Skills/Extensions 只有 `--trust-project` 后加载；
- 非 TTY 的 `ask` 降为 `deny`；
- workspace/realpath/symlink 边界和默认保护路径；
- critical Shell 与保护路径不可被普通 approval 覆盖；
- Tool 子进程只获得精简环境，不继承 Provider/OAuth secret；
- OAuth state + PKCE，HTTPS endpoint，加密凭据库，Token 不输出；
- OIDC discovery 校验 issuer/HTTPS endpoint，token endpoint client auth negotiation 和 revoke；
- Session/RPC 图片运行时验证；
- 人类终端输出移除模型控制字符，HTML export 有 CSP/no-referrer；
- registry Extension 禁 lifecycle script、验 signature/integrity、exact lock；
- Session Share 默认脱敏/省略 Tool output 和图片，导入/下载/服务器均验 Ed25519；
- 企业模式强制 Provider/model/extension allowlist、非 Host Sandbox、digest image、本地媒体和
  32-byte+ audit HMAC key；
- CLI/SDK 事件写入内容最小化 HMAC-SHA-256 chain，正文和 Tool output 只记录 digest/bytes；
- 审计记录带 `keyId`，签名密钥经 `AuditKeyProvider` 接缝注入（默认 `EnvAuditKeyProvider`
  读取静态环境变量 key）；该接缝是 KMS/密钥轮换的挂接点——轮换后 verify 按每条记录的
  `keyId` 选钥验签，未知 `keyId` fail closed；
- 集中式 audit verification、WORM 存储与 retention 仍是部署侧外部 Gate，文件层 chain 只做
  篡改证据（tamper-evidence），不替代组织级审计管线；
- 审计 Kernel 保持 Decision/Effect、Grant/Receipt、Ledger 和 Verifier Gate。

## Host 不是 Sandbox

`--sandbox host` 是兼容路径。它有路径保护、权限、命令分类、环境清理、timeout 和 abort，但
仓库代码仍以当前 OS 用户运行，可以读取该用户其他文件、联网、调用本机工具或尝试漏洞利用。
只在可信或可丢弃环境使用。

## 容器与 VM 的边界

容器只包住 Bash 和由 Bash 启动的仓库代码。Provider HTTP、OAuth、Session、受控文件 primitive
和 Extension Host 在 CLI 进程中，避免把模型凭据放进不可信执行环境。

Docker isolation 不等于 VM isolation；gVisor 降低 shared-kernel attack surface；SSH VM driver
依赖外部 provisioner 保证实例独占、镜像可信、网络受控、磁盘清理和 lease 销毁。

当前交付机器没有 Docker/runsc/Firecracker/QEMU，因此物理 runtime 尚未在本机执行。不要把
命令构造测试解读为生产隔离证明。

## OAuth 与凭据

- 不把 client secret 作为 CLI 参数；使用 `FOCUSCODE_<PROVIDER>_CLIENT_SECRET`；
- 默认本地 encryption key 与 database 分开且权限 `0600`，但同一 OS 用户失陷时两者都可能
  被读取；高安全环境使用 passphrase/OS keychain/HSM adapter；
- 自定义 OAuth endpoint 必须 HTTPS；
- 使用最小 scope、短期 access token 和可撤销 refresh token；
- Provider 是否接受某 OAuth token 是服务端策略，不因 FocusCode 能获取 token 而自动成立。
- 五类命名模型默认使用官方 API key；标准 OIDC 支持不等于获得厂商订阅 OAuth 授权。
- Provider tool continuation state 可能包含私有推理内容；它只保存在本地 Session，分享包会
  始终移除 `providerState`。高安全环境需加密 Session volume 并设置 retention。

## Extension

Extension package 默认在进程内运行。npm signature、integrity 和 manifest permission 是供应链与
用户同意控制，不是 capability containment。恶意 factory/command/listener 可以使用 Node 权限。
只加载可信代码。

`extensions.host: "process"` 把每个扩展放进独立 Node 子进程（stdio JSON-RPC），提供可靠性
隔离（扩展崩溃不拖垮宿主）与权限运行时强制的挂点，但不是安全沙箱：子进程仍以当前用户权限
运行，env 白名单只阻止父进程 secret 直接进入子进程环境，不拦截文件/网络/系统调用。生产前的
完整目标仍是 WASI 级 containment 和能力代理。

## 分享

Ed25519 自签名证明完整性，不证明真实身份或内容安全。Share Server 可强制 Bearer、可信 signer
fingerprint、最大年龄和限流，但默认脱敏仍是 best-effort，不能发现所有
业务 secret。带 `--include-tool-output` 或 `--include-images` 的 bundle 必须人工审阅。外部
Session 恢复时先使用 `approval=deny`。

## 已知限制

- Session JSONL 无 fsync/WAL/checksum/migration/多进程 lease；
- Conversational Agent Tool effect 无 unknown-effect reconciliation；
- 非企业模式仍允许 tag image；企业模式强制 `@sha256:` 且 `--pull never`；
- Docker/gVisor adversarial job 尚未在 CI 真实运行；
- VM 无 provision/attestation/destroy；
- Extension 无运行时 containment/revocation（`extensions.host: "process"` 是崩溃隔离，不是
  containment）；
- Share Server 有 token/signer/age/rate 基础控制，但无组织身份、对象级 ACL、删除、HA 数据库、
  配额和完整滥用治理；
- MCP/A2A/ACP 仍以 contract boundary 为主，非完整认证网络实现；
- 没有真实模型任务矩阵或安全证书。

## 生产 Gate

1. 目标平台真实 Docker/runsc/VM adversarial suite；
2. image digest、SBOM、签名、漏洞扫描与最小 toolchain；
3. 每任务独立实例、默认断网、allowlisted egress、Secret Broker；
4. durable Action Started/Receipt、outbox、fencing、unknown reconciliation；
5. 组织 OIDC/RBAC、短期 workload grant、集中式 audit verification 与 retention；
6. Extension process sandbox、permission enforcement、allowlist/revocation；
7. Session checksum/migration/repair/backup；
8. 分享身份信任、ACL、TTL、删除、滥用和内容治理；
9. Windows/macOS/Linux terminal、path、process 与 sandbox matrix。

## Contributor rules

- 不让 Provider、fs、Shell、网络或 UI 进入 `harness-core`；
- 不让 Approval 覆盖组织 hard deny；
- Tool 参数完整解析和 Schema 验证前不执行；
- 任何自动授权扩大必须增加绕过测试；
- Provider secret 不进入 Prompt、Session、Tool 环境或普通日志；
- 不信任模型/Tool/Extension 输出中的终端控制字符；
- Project resource 必须经过 project trust；
- Security boundary 变化同步 threat model、文档和 adversarial tests。

## Reporting

当前仓库没有配置公开部署的私密漏洞接收渠道。正式部署前必须建立私密报告、响应 SLO、
CVE/公告和安全版本发布流程。
