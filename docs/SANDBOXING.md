# Docker、gVisor 与 VM 隔离

## 1. 安全默认值

v0.4 默认配置：

```json
{
  "sandbox": {
    "kind": "auto",
    "image": "node:22-bookworm",
    "network": "none",
    "allowHostFallback": false,
    "requireImageDigest": false
  }
}
```

`auto` 先检查 Docker 的 `runsc` runtime，再检查普通 Docker。两者都不可用时直接失败，不会
静默使用 Host。Host 只有 `--sandbox host` 或显式允许 fallback 才可进入，并打印警告。

```bash
focuscode sandbox doctor --kind auto
focuscode sandbox doctor --kind docker
focuscode sandbox doctor --kind gvisor
```

## 2. Docker 后端

每条 Bash Tool Call 使用一次 `docker run --rm`，workspace bind 到 `/workspace`。固定控制：

- `--read-only` root filesystem；
- `/tmp` 是 `rw,noexec,nosuid,nodev` tmpfs；
- 默认 `--network none`，需要下载依赖时显式 `bridge`；
- `--ipc none`、`--log-driver none`；
- `--cap-drop ALL`；
- `--security-opt no-new-privileges=true`；
- Docker 默认 seccomp；
- `--pids-limit 256`、`--memory 2g`、`--cpus 2`；
- Linux 映射当前 UID/GID，避免容器以 root 修改 workspace；
- `HOME=/tmp`，不挂载 Host HOME；
- Host CLI 子进程只获得精简环境，不继承模型凭据；
- `--init` 负责孤儿进程回收；
- 每次运行有唯一 container name；timeout/abort 后额外 `docker rm --force`。

企业模式要求 `requireImageDigest=true`，只接受 `image@sha256:<64 hex>`，并给 Docker 传
`--pull never`；readiness 会先验证该 digest image 已存在于目标节点。

```bash
focuscode --sandbox docker --sandbox-image node:22-bookworm \
  --sandbox-network none
```

项目需要更多 toolchain 时构建：

```bash
pnpm sandbox:image
focuscode --sandbox docker --sandbox-image focuscode/sandbox:node22
```

`infra/sandbox/Dockerfile` 是基线，不是所有语言的万能镜像。生产环境应固定 digest、生成 SBOM、
签名镜像并用组织 registry。

```bash
focuscode init --enterprise \
  --sandbox-image registry.example.com/focuscode/node22@sha256:<digest>
focuscode doctor --repo .
```

## 3. gVisor

安装 runsc 并在 Docker 注册 runtime 后：

```bash
focuscode sandbox doctor --kind gvisor
focuscode --sandbox gvisor
```

gVisor 使用与 Docker 相同的 mount/network/cgroup/permission 配置，并追加 `--runtime runsc`。
它减少容器直接共享 Host kernel attack surface，但不是 VM，也不替代及时升级、镜像最小化和
凭据隔离。

## 4. VM / microVM

FocusCode 使用 SSH 控制一个已经创建、可丢弃且共享 workspace 的 VM：

```bash
focuscode --sandbox vm \
  --vm-host focus@192.0.2.10 \
  --vm-workspace /mnt/focuscode/workspace \
  --vm-identity ~/.ssh/focuscode_vm
```

约束：

- Host 必须是简单 SSH target，拒绝 shell metacharacter；
- remote workspace 必须绝对路径；
- BatchMode、默认 StrictHostKeyChecking=yes；
- 远端 `env -i`，只给 HOME/PATH/CI；
- cwd 由本地 workspace 相对路径映射；
- command 和路径使用 POSIX single-quote escaping；
- 远端 GNU `timeout --kill-after=5s` 约束进程组；
- 本地 SSH 还有第二层 timeout/abort。

`infra/vm/cloud-init.yaml` 提供预置参考。VM 可以是 Firecracker、QEMU、云 VM 或其他 SSH
可达实例。FocusCode v0.4 不负责创建、attest、快照或销毁 VM；调度系统必须保证每任务实例、
网络策略、磁盘清理和 lease 到期销毁。

## 5. Host 兼容模式

```bash
focuscode --sandbox host
```

Host mode 仍具有 workspace/realpath/symlink 保护、危险命令分类、权限审批、精简环境、timeout、
abort 和输出上限，但没有 mount namespace、网络隔离或 kernel boundary。仓库脚本可以读取同一
OS 用户可访问的其他文件、联网或利用本机工具。只在可信或可丢弃环境使用。

## 6. 什么被隔离

Bash 和通过 Bash 启动的编译器、测试、包管理器进入所选 Sandbox。`read/write/edit/apply_patch`
是 Harness 自身受控文件 primitive，在 Host CLI 进程中执行，但被 workspace、symlink、保护路径
和 Permission Controller 限制；它们不运行仓库代码。

模型 HTTP 请求、OAuth refresh、Session 存储和扩展 Host 也在 CLI 进程，不在 Bash Sandbox。
这是一条刻意边界：Provider Token 不进入不可信代码执行环境。

## 7. 运行时验收矩阵

自动化单元/契约测试覆盖：

- Docker/gVisor 参数、非 root、mount、断网、capability、runtime；
- timeout 后强制 remove；
- auto 探测和禁止静默 Host fallback；
- VM strict SSH、cwd mapping、quote 和远端 timeout；
- workspace escape；
- 真实 Host process stdin/stdout/stderr、截断、exit、timeout、abort、spawn error。

当前交付环境只检测到 `/usr/bin/ssh`，没有 Docker、runsc、Firecracker 或 QEMU。因此本报告
不能声称在这台机器完成了真实容器/microVM execution。部署时必须执行：

1. `focuscode sandbox doctor`；
2. 在目标镜像运行仓库测试；
3. 验证默认断网；
4. 尝试读取 Host HOME/secret；
5. 测试 daemon/fork bomb/timeout/OOM；
6. 确认容器或 VM 在 abort 后消失。
