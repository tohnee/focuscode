import { DockerSandbox, HostSandbox, SshVmSandbox } from "./executors.js";
import { SeatbeltSandbox } from "./seatbelt.js";
import type { SandboxConfig, SandboxExecutor } from "./types.js";

export async function createSandbox(config: SandboxConfig): Promise<SandboxExecutor> {
  if (config.kind === "host") return new HostSandbox(config);
  if (config.kind === "docker") {
    return requireAvailable(new DockerSandbox(config));
  }
  if (config.kind === "gvisor") {
    return requireAvailable(new DockerSandbox({ ...config, runtime: "runsc" }));
  }
  if (config.kind === "seatbelt") {
    return requireAvailable(new SeatbeltSandbox(config));
  }
  if (config.kind === "vm") {
    if (!config.vm) throw new Error("VM sandbox requires vm.host and vm.remoteWorkspace");
    return requireAvailable(
      new SshVmSandbox({ workspaceRoot: config.workspaceRoot, ...config.vm }),
    );
  }
  // auto: gVisor → Docker → seatbelt (darwin only) → host (if allowed) → fail
  const gvisor = new DockerSandbox({ ...config, runtime: "runsc" });
  if ((await gvisor.health()).available) return gvisor;
  const docker = new DockerSandbox(config);
  if ((await docker.health()).available) return docker;
  const seatbelt = new SeatbeltSandbox(config);
  if ((await seatbelt.health()).available) return seatbelt;
  if (config.allowHostFallback) return new HostSandbox(config);
  throw new Error(
    "No isolated sandbox is available; install Docker/gVisor or configure a VM. Host fallback is disabled.",
  );
}

async function requireAvailable(executor: SandboxExecutor): Promise<SandboxExecutor> {
  const health = await executor.health();
  if (!health.available) throw new Error(`${executor.kind} sandbox unavailable: ${health.detail}`);
  return executor;
}
