# v0.3 Alpha Threat Model

| Threat                       | Entry                          | Current control                                                      | Residual risk / next control                                       |
| ---------------------------- | ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Repo prompt injection        | Source/README/tool output      | System/data separation、project trust、Tool 单独授权                 | 真实 adversarial repo、retrieval trust labels                      |
| Partial/malformed Tool Call  | Provider SSE/JSON              | 完整组装和 JSON object 后才执行；最多 16 calls                       | Recorded provider differential/fuzz                                |
| Model terminal injection     | text/reasoning/tool output     | TUI/Human renderer 移除 control chars；JSON escaped                  | 跨 chunk/跨终端矩阵与 hyperlink policy                             |
| Path/symlink escape          | read/write/edit/patch/bash cwd | workspace resolve/realpath/missing-parent guard；Sandbox mount       | Windows path fuzz、mount adversarial suite                         |
| Protected mutation           | file tools/patch/bash          | 默认保护路径、patch header scan、Permission hard deny                | 解释器/编码绕过；read-only mounts for selected paths               |
| Shell destruction            | Bash/`!`                       | risk classifier、critical hard deny、timeout/abort                   | 静态分类不是 sandbox；OS policy/remote action broker               |
| Tool secret inheritance      | child env                      | 精简环境；Provider/OAuth Token 不进入 Sandbox                        | repo 可读取 workspace 内用户 secret；Secret Broker                 |
| Network exfiltration         | repo process                   | Docker/gVisor default `network none`                                 | Host/bridge/VM policy；allowlisted egress broker                   |
| Container escape             | malicious compiler/test        | read-only root、cap-drop、NNP、seccomp、limits；可选 gVisor          | 真实 runtime red-team、patched kernel、microVM                     |
| Orphan/daemon                | timeout/abort                  | Docker init、唯一名、强制 rm；VM remote timeout                      | Docker daemon failure、VM destroy/lease                            |
| OAuth CSRF/code interception | browser callback               | random state、PKCE S256、127.0.0.1、exact path、timeout              | malicious local user/process；claimed HTTPS redirect/custom scheme |
| Credential theft             | local files/logs               | AES-GCM、0600、optional passphrase、no token logging                 | same-user compromise；OS keychain/HSM                              |
| Malicious image              | local/RPC/session              | magic bytes、MIME/size/base64/digest、HTTPS URL policy               | Provider decoder bugs；image preprocessing sandbox                 |
| Malicious Extension          | npm/project/explicit JS        | no install scripts、signature/integrity/lock、trust/signature policy | In-process Node authority；process/WASI capability sandbox         |
| Extension partial install    | validation/signature failure   | transactional uninstall on post-install error                        | npm/FS crash recovery and lock reconciliation                      |
| Share tampering              | local/remote bundle            | canonical Ed25519 verify on read/download/server/import              | Self-signed identity not trusted identity                          |
| Share data leakage           | Session export                 | default secret redaction, omit tools/images, size bounds             | Pattern misses business secrets；DLP/manual review                 |
| Share prompt poisoning       | imported history               | explicit import、new local id/cwd、message validation                | Signed malicious content；quarantine/read-only review mode         |
| Duplicate/unknown effect     | retry/crash                    | Single turn and sequential writes；Audited Kernel receipt path       | Conversational loop lacks durable reconciliation                   |
| Session corruption           | partial JSONL/external edit    | parse isolation、runtime message/image validation、IDs               | WAL/checksum/migration/repair/lease                                |
| Steering race                | concurrent input               | one main run、bounded FIFO、child generation abort only              | Tool cannot be safely preempted；UI semantics testing              |
| Context poisoning            | old tool/session summary       | role tagging、original history retained、user-owned compaction       | Summary omissions/injection；provenance-aware compaction           |
| Model/Profile drift          | endpoint/config                | explicit protocol/profile/tool mode/config validation                | revision certificate、recording、expiry/revoke/canary              |
| MCP/A2A confused deputy      | future gateway                 | contract boundary、no broad live delegation in v0.3                  | workload identity、scoped grants、depth/budget enforcement         |

## Highest residual risks

1. Extension 是进程内可信代码；
2. 当前机器未真实执行 Docker/gVisor/VM adversarial suite；
3. Conversational effect 无 durable unknown-effect recovery；
4. Self-signed share 无组织身份信任；
5. Host compatibility mode 仍以当前 OS 用户作为安全边界。

生产部署必须选择物理隔离、关闭 Host fallback、固定镜像 digest、使用短期凭据，并补齐真实
runtime red-team 和 effect reconciliation。
