import { describe, expect, it } from "vitest";
import { analyzeShellCommand, classifyShell, isArbitraryShell } from "../src/index.js";

describe("analyzeShellCommand", () => {
  it("splits command chains on control operators", () => {
    const analysis = analyzeShellCommand("ls -la && git status; echo done | less\ncat x");
    expect(analysis.segments).toEqual(["ls -la", "git status", "echo done", "less", "cat x"]);
  });

  it("treats a single & as a separator but &> as redirection", () => {
    expect(analyzeShellCommand("ls & sleep 1").segments).toEqual(["ls", "sleep 1"]);
    const redirect = analyzeShellCommand("make build &> log.txt");
    expect(redirect.segments).toEqual(["make build &> log.txt"]);
    expect(redirect.hasRedirection).toBe(true);
  });

  it("does not split on operators inside quotes", () => {
    expect(analyzeShellCommand('echo "a|b"').segments).toEqual(['echo "a|b"']);
    expect(analyzeShellCommand("echo 'a;b'").segments).toEqual(["echo 'a;b'"]);
    expect(analyzeShellCommand('echo "a && b"; ls').segments).toEqual(['echo "a && b"', "ls"]);
  });

  it("does not split inside command substitution", () => {
    const analysis = analyzeShellCommand("echo $(ls; rm x) && git status");
    expect(analysis.segments).toEqual(["echo $(ls; rm x)", "git status"]);
    expect(analysis.hasCommandSubstitution).toBe(true);
  });

  it("detects command substitution, including inside double quotes", () => {
    expect(analyzeShellCommand("cat $(id)").hasCommandSubstitution).toBe(true);
    expect(analyzeShellCommand("cat `id`").hasCommandSubstitution).toBe(true);
    expect(analyzeShellCommand('echo "$(id)"').hasCommandSubstitution).toBe(true);
    expect(analyzeShellCommand("echo `id`").hasCommandSubstitution).toBe(true);
    expect(analyzeShellCommand("echo '$(id)'").hasCommandSubstitution).toBe(false);
    expect(analyzeShellCommand("ls src").hasCommandSubstitution).toBe(false);
  });

  it("detects variable and tilde expansion outside single quotes", () => {
    expect(analyzeShellCommand("echo $HOME").hasExpansion).toBe(true);
    expect(analyzeShellCommand("echo ${HOME}").hasExpansion).toBe(true);
    expect(analyzeShellCommand('echo "$HOME"').hasExpansion).toBe(true);
    expect(analyzeShellCommand("ls ~").hasExpansion).toBe(true);
    expect(analyzeShellCommand("echo '$HOME'").hasExpansion).toBe(false);
    expect(analyzeShellCommand("ls src").hasExpansion).toBe(false);
  });

  it("detects redirection outside quotes", () => {
    expect(analyzeShellCommand("ls > /tmp/x").hasRedirection).toBe(true);
    expect(analyzeShellCommand("ls >> /tmp/x").hasRedirection).toBe(true);
    expect(analyzeShellCommand("cat < in.txt").hasRedirection).toBe(true);
    expect(analyzeShellCommand("echo hi 2>&1").hasRedirection).toBe(true);
    expect(analyzeShellCommand("echo 'a>b'").hasRedirection).toBe(false);
    expect(analyzeShellCommand('echo "a>b"').hasRedirection).toBe(false);
    expect(analyzeShellCommand("ls src").hasRedirection).toBe(false);
  });

  it("detects interpreter wrappers in command position", () => {
    expect(analyzeShellCommand("python -c 'pass'").wrappedInterpreters).toEqual(["python"]);
    expect(analyzeShellCommand('bash -c "rm x"').wrappedInterpreters).toEqual(["bash"]);
    expect(analyzeShellCommand("/bin/sh -c x").wrappedInterpreters).toEqual(["sh"]);
    expect(analyzeShellCommand("python3.11 -V").wrappedInterpreters).toEqual(["python3.11"]);
    expect(analyzeShellCommand('eval "$CMD"').wrappedInterpreters).toEqual(["eval"]);
  });

  it("follows chainable wrappers to the wrapped command", () => {
    expect(analyzeShellCommand("sudo bash -c x").wrappedInterpreters).toEqual(["sudo", "bash"]);
    expect(analyzeShellCommand("nice python -c x").wrappedInterpreters).toContain("nice");
    expect(analyzeShellCommand("env FOO=1 sh -c x").wrappedInterpreters).toEqual(["env", "sh"]);
  });

  it("does not flag interpreter names used as arguments", () => {
    expect(analyzeShellCommand("echo bash").wrappedInterpreters).toEqual([]);
    expect(analyzeShellCommand("git status").wrappedInterpreters).toEqual([]);
    expect(analyzeShellCommand("grep python README.md").wrappedInterpreters).toEqual([]);
  });

  it("detects interpreters in later segments of a chain", () => {
    expect(analyzeShellCommand("ls; sh -c x").wrappedInterpreters).toEqual(["sh"]);
  });
});

describe("classifyShell structural rules", () => {
  it("takes the highest risk across chained commands", () => {
    expect(classifyShell("ls").risk).toBe("low");
    expect(["high", "critical"]).toContain(classifyShell("ls; rm -rf ~").risk);
    expect(classifyShell("ls && git reset --hard HEAD").risk).toBe("high");
    expect(classifyShell("echo hi | sudo tee /etc/x").risk).toBe("high");
  });

  it("elevates interpreter wrappers to high with a wrapper reason", () => {
    const python = classifyShell("python -c \"import os; os.system('x')\"");
    expect(python.risk).toBe("high");
    expect(python.reason).toContain("interpreter wrapper can execute arbitrary code");
    expect(classifyShell('bash -c "rm x"').risk).toBe("high");
    expect(classifyShell('eval "$CMD"').risk).toBe("high");
    expect(classifyShell("sh script.sh").risk).toBe("high");
  });

  it("elevates command substitution to high with a substitution reason", () => {
    expect(classifyShell("cat $(rm -rf ~)").risk).toBe("high");
    const backtick = classifyShell("cat `id`");
    expect(backtick.risk).toBe("high");
    expect(backtick.reason).toBe("command substitution hides nested commands");
    expect(classifyShell("echo $(id)").risk).toBe("high");
  });

  it("does not elevate plain expansion, but wraps still elevate", () => {
    expect(classifyShell("$X").risk).toBe("medium");
    expect(classifyShell("echo $X").risk).toBe("medium");
    expect(classifyShell('sh -c "$X"').risk).toBe("high");
  });

  it("keeps read-only commands low", () => {
    expect(classifyShell("git status").risk).toBe("low");
    expect(classifyShell("ls -la").risk).toBe("low");
    expect(classifyShell("rg foo").risk).toBe("low");
  });

  it("blocks low when the command writes via redirection or chains commands", () => {
    expect(classifyShell("ls > /tmp/x").risk).not.toBe("low");
    expect(classifyShell("ls; ls").risk).not.toBe("low");
    expect(classifyShell("cat $(pwd)").risk).not.toBe("low");
  });

  it("never lowers existing regex classifications", () => {
    expect(classifyShell("dd if=/dev/zero of=/dev/sda").risk).toBe("critical");
    expect(classifyShell("sudo apt-get update").risk).toBe("high");
    expect(classifyShell("pnpm test").risk).toBe("medium");
    expect(classifyShell("echo hi").risk).toBe("medium");
    expect(classifyShell("cat /etc/passwd").risk).toBe("medium");
  });

  it("keeps the invalid-input contract", () => {
    expect(classifyShell("").risk).toBe("high");
    expect(classifyShell("   ").risk).toBe("high");
    expect(classifyShell(42).risk).toBe("high");
  });
});

describe("isArbitraryShell", () => {
  it("flags multi-segment chains", () => {
    expect(isArbitraryShell("ls; ls")).toBe(true);
    expect(isArbitraryShell("git status && ls")).toBe(true);
  });

  it("flags interpreter wrappers and command substitution", () => {
    expect(isArbitraryShell("python -c pass")).toBe(true);
    expect(isArbitraryShell("bash -c ls")).toBe(true);
    expect(isArbitraryShell("echo $(id)")).toBe(true);
    expect(isArbitraryShell("cat `id`")).toBe(true);
  });

  it("flags redirection and unknown commands", () => {
    expect(isArbitraryShell("ls > /tmp/x")).toBe(true);
    expect(isArbitraryShell("curl https://example.com")).toBe(true);
    expect(isArbitraryShell("echo hi")).toBe(true);
  });

  it("flags empty or non-string input", () => {
    expect(isArbitraryShell("")).toBe(true);
    expect(isArbitraryShell("   ")).toBe(true);
  });

  it("accepts known read-only commands", () => {
    expect(isArbitraryShell("git status")).toBe(false);
    expect(isArbitraryShell("ls -la")).toBe(false);
    expect(isArbitraryShell("rg foo src")).toBe(false);
  });

  it("flags interpreter invocations even for benign-looking arguments", () => {
    expect(isArbitraryShell("node --version")).toBe(true);
    expect(classifyShell("node --version").risk).toBe("high");
  });

  it("accepts trusted project commands", () => {
    expect(isArbitraryShell("pnpm test")).toBe(false);
    expect(isArbitraryShell("make build")).toBe(false);
    expect(isArbitraryShell("cargo check")).toBe(false);
  });
});
