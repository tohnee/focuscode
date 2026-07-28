import { describe, expect, it } from "vitest";
import {
  AbortError,
  PermissionDeniedError,
  SandboxUnavailableError,
  SchemaValidationError,
  SessionCorruptedError,
  TimeoutError,
  ToolExecutionError,
  classifyError,
  getErrorCode,
  isFailClosed,
  isFocusCodeError,
  isRetryable,
  type ErrorCategory,
  type ErrorClassification,
  type ErrorSeverity,
} from "../src/index.js";
import {
  CircuitOpenError,
  ModelHttpError,
  ModelResponseDriftError,
  McpPinMismatchError,
  GraphCycleError,
  NativeProviderHttpError,
} from "@focuscode/agent-runtime";
import { McpSchemaChangedError } from "@focuscode/protocols";
import { OAuthProtocolError } from "@focuscode/auth";
import { VersionConflictError } from "@focuscode/persistence";

/**
 * P1-1: Error code classification (review §7 P1-1).
 *
 * Goal: provide a single classification surface that maps every well-known
 * FocusCode error (and common anonymous Error instances) onto
 * { code, category, severity, retryable, failClosed } so integrators can
 * build uniform retry / alert / fail-closed logic without sniffing names.
 */
describe("classifyError()", () => {
  it("is exported from the SDK entry", () => {
    expect(typeof classifyError).toBe("function");
  });

  describe("auth errors", () => {
    it("classifies OAuthProtocolError as auth/error/non-retryable/non-fail-closed", () => {
      const err = new OAuthProtocolError("authorization_pending", "authorization_pending", 400);
      const result = classifyError(err);
      expect(result.code).toBe("AUTH_OAUTH_PROTOCOL");
      expect(result.category).toBe("auth");
      expect(result.severity).toBe("error");
      expect(result.retryable).toBe(false);
      expect(result.failClosed).toBe(false);
    });

    it("marks authorization_pending as retryable (device-code polling)", () => {
      const err = new OAuthProtocolError("authorization_pending", "authorization_pending");
      expect(classifyError(err).retryable).toBe(true);
    });

    it("marks slow_down as retryable (device-code backoff)", () => {
      const err = new OAuthProtocolError("slow_down", "slow_down");
      expect(classifyError(err).retryable).toBe(true);
    });
  });

  describe("model errors", () => {
    it("classifies 5xx ModelHttpError as retryable model error", () => {
      const err = new ModelHttpError("upstream boom", 503, "{}");
      const result = classifyError(err);
      expect(result.code).toBe("MODEL_HTTP");
      expect(result.category).toBe("model");
      expect(result.severity).toBe("error");
      expect(result.retryable).toBe(true);
      expect(result.failClosed).toBe(false);
    });

    it("classifies 429 ModelHttpError as retryable", () => {
      const err = new ModelHttpError("rate limited", 429, "{}");
      expect(classifyError(err).retryable).toBe(true);
    });

    it("classifies 4xx ModelHttpError (non-429) as non-retryable", () => {
      const err = new ModelHttpError("bad request", 400, "{}");
      expect(classifyError(err).retryable).toBe(false);
    });

    it("classifies ModelResponseDriftError as fail-closed", () => {
      const err = new ModelResponseDriftError("fp-expected", "fp-observed");
      const result = classifyError(err);
      expect(result.code).toBe("MODEL_RESPONSE_DRIFT");
      expect(result.category).toBe("model");
      expect(result.severity).toBe("error");
      expect(result.retryable).toBe(false);
      expect(result.failClosed).toBe(true);
    });

    it("classifies NativeProviderHttpError as model error", () => {
      const err = new NativeProviderHttpError("gemini 500", 500, "{}");
      const result = classifyError(err);
      expect(result.code).toBe("MODEL_NATIVE_HTTP");
      expect(result.category).toBe("model");
      expect(result.retryable).toBe(true);
    });
  });

  describe("mcp errors", () => {
    it("classifies McpSchemaChangedError as fatal/fail-closed", () => {
      const pin = {
        serverId: "s",
        serverVersion: "1",
        toolName: "t",
        schemaDigest: "d1",
        transportDigest: "d2",
      };
      const err = new McpSchemaChangedError(pin, { ...pin, schemaDigest: "d3" });
      const result = classifyError(err);
      expect(result.code).toBe("MCP_SCHEMA_CHANGED");
      expect(result.category).toBe("mcp");
      expect(result.severity).toBe("fatal");
      expect(result.retryable).toBe(false);
      expect(result.failClosed).toBe(true);
    });

    it("classifies McpPinMismatchError as fatal/fail-closed", () => {
      const err = new McpPinMismatchError("s", "t", "schemaDigest changed");
      const result = classifyError(err);
      expect(result.code).toBe("MCP_PIN_MISMATCH");
      expect(result.category).toBe("mcp");
      expect(result.severity).toBe("fatal");
      expect(result.failClosed).toBe(true);
    });
  });

  describe("circuit errors", () => {
    it("classifies CircuitOpenError as warning/retryable-after-cooldown", () => {
      const err = new CircuitOpenError("provider/model", 5_000);
      const result = classifyError(err);
      expect(result.code).toBe("CIRCUIT_OPEN");
      expect(result.category).toBe("circuit");
      expect(result.severity).toBe("warning");
      expect(result.retryable).toBe(true);
      expect(result.failClosed).toBe(false);
    });
  });

  describe("persistence errors", () => {
    it("classifies VersionConflictError as persistence/non-retryable", () => {
      const err = new VersionConflictError(3, 7);
      const result = classifyError(err);
      expect(result.code).toBe("PERSISTENCE_VERSION_CONFLICT");
      expect(result.category).toBe("persistence");
      expect(result.severity).toBe("error");
      expect(result.retryable).toBe(false);
    });
  });

  describe("graph errors", () => {
    it("classifies GraphCycleError as graph/non-retryable", () => {
      const err = new GraphCycleError(["a", "b", "a"]);
      const result = classifyError(err);
      expect(result.code).toBe("GRAPH_CYCLE");
      expect(result.category).toBe("graph");
      expect(result.severity).toBe("error");
      expect(result.retryable).toBe(false);
    });
  });

  describe("permission errors", () => {
    it("classifies PermissionDeniedError as permission/non-fail-closed", () => {
      const err = new PermissionDeniedError("write_file", "deny");
      const result = classifyError(err);
      expect(result.code).toBe("PERMISSION_DENIED");
      expect(result.category).toBe("permission");
      expect(result.severity).toBe("warning");
      expect(result.retryable).toBe(false);
      expect(result.failClosed).toBe(false);
    });
  });

  describe("sandbox errors", () => {
    it("classifies SandboxUnavailableError as sandbox/fatal/fail-closed", () => {
      const err = new SandboxUnavailableError("auto", "all executors unhealthy");
      const result = classifyError(err);
      expect(result.code).toBe("SANDBOX_UNAVAILABLE");
      expect(result.category).toBe("sandbox");
      expect(result.severity).toBe("fatal");
      expect(result.retryable).toBe(false);
      expect(result.failClosed).toBe(true);
    });
  });

  describe("schema errors", () => {
    it("classifies SchemaValidationError as schema/non-retryable", () => {
      const err = new SchemaValidationError("task-spec.v1", "missing field: objective");
      const result = classifyError(err);
      expect(result.code).toBe("SCHEMA_VALIDATION");
      expect(result.category).toBe("schema");
      expect(result.severity).toBe("error");
      expect(result.retryable).toBe(false);
    });
  });

  describe("session errors", () => {
    it("classifies SessionCorruptedError as session/fatal/fail-closed", () => {
      const err = new SessionCorruptedError("sess-123", "JSON parse failed");
      const result = classifyError(err);
      expect(result.code).toBe("SESSION_CORRUPTED");
      expect(result.category).toBe("session");
      expect(result.severity).toBe("fatal");
      expect(result.failClosed).toBe(true);
    });
  });

  describe("tool errors", () => {
    it("classifies ToolExecutionError as tool/non-retryable", () => {
      const err = new ToolExecutionError("bash", "exit code 1");
      const result = classifyError(err);
      expect(result.code).toBe("TOOL_EXECUTION");
      expect(result.category).toBe("tool");
      expect(result.severity).toBe("error");
      expect(result.retryable).toBe(false);
    });
  });

  describe("timeout errors", () => {
    it("classifies TimeoutError as timeout/retryable", () => {
      const err = new TimeoutError("model request", 30_000);
      const result = classifyError(err);
      expect(result.code).toBe("TIMEOUT");
      expect(result.category).toBe("timeout");
      expect(result.severity).toBe("warning");
      expect(result.retryable).toBe(true);
    });
  });

  describe("abort errors", () => {
    it("classifies AbortError as abort/info/non-retryable", () => {
      const err = new AbortError("user aborted");
      const result = classifyError(err);
      expect(result.code).toBe("ABORT");
      expect(result.category).toBe("abort");
      expect(result.severity).toBe("info");
      expect(result.retryable).toBe(false);
    });

    it("classifies native DOMException AbortError as abort", () => {
      const err = new DOMException("aborted", "AbortError");
      const result = classifyError(err);
      expect(result.code).toBe("ABORT");
      expect(result.category).toBe("abort");
    });
  });

  describe("unknown errors", () => {
    it("classifies anonymous Error as unknown", () => {
      const err = new Error("boom");
      const result = classifyError(err);
      expect(result.code).toBe("UNKNOWN");
      expect(result.category).toBe("unknown");
      expect(result.severity).toBe("error");
      expect(result.retryable).toBe(false);
      expect(result.failClosed).toBe(false);
    });

    it("classifies non-Error values as unknown", () => {
      const result = classifyError("string error");
      expect(result.code).toBe("UNKNOWN");
      expect(result.category).toBe("unknown");
    });
  });
});

describe("getErrorCode()", () => {
  it("returns the stable code string for a known error", () => {
    const err = new CircuitOpenError("k", 1_000);
    expect(getErrorCode(err)).toBe("CIRCUIT_OPEN");
  });

  it("returns UNKNOWN for anonymous errors", () => {
    expect(getErrorCode(new Error("x"))).toBe("UNKNOWN");
  });
});

describe("isRetryable()", () => {
  it("returns true for CircuitOpenError", () => {
    expect(isRetryable(new CircuitOpenError("k", 1_000))).toBe(true);
  });

  it("returns true for 5xx ModelHttpError", () => {
    expect(isRetryable(new ModelHttpError("boom", 503, "{}"))).toBe(true);
  });

  it("returns false for 4xx ModelHttpError", () => {
    expect(isRetryable(new ModelHttpError("bad", 400, "{}"))).toBe(false);
  });

  it("returns false for McpSchemaChangedError", () => {
    const pin = {
      serverId: "s",
      serverVersion: "1",
      toolName: "t",
      schemaDigest: "d1",
      transportDigest: "d2",
    };
    expect(isRetryable(new McpSchemaChangedError(pin, { ...pin, schemaDigest: "x" }))).toBe(false);
  });
});

describe("isFailClosed()", () => {
  it("returns true for McpSchemaChangedError", () => {
    const pin = {
      serverId: "s",
      serverVersion: "1",
      toolName: "t",
      schemaDigest: "d1",
      transportDigest: "d2",
    };
    expect(isFailClosed(new McpSchemaChangedError(pin, { ...pin, schemaDigest: "x" }))).toBe(true);
  });

  it("returns true for SandboxUnavailableError", () => {
    expect(isFailClosed(new SandboxUnavailableError("auto", "down"))).toBe(true);
  });

  it("returns false for CircuitOpenError", () => {
    expect(isFailClosed(new CircuitOpenError("k", 1_000))).toBe(false);
  });
});

describe("isFocusCodeError()", () => {
  it("returns true for any classified FocusCode error", () => {
    expect(isFocusCodeError(new CircuitOpenError("k", 1))).toBe(true);
    expect(isFocusCodeError(new OAuthProtocolError("x", "x"))).toBe(true);
    expect(isFocusCodeError(new TimeoutError("op", 1))).toBe(true);
  });

  it("returns false for anonymous Error", () => {
    expect(isFocusCodeError(new Error("x"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isFocusCodeError("x")).toBe(false);
    expect(isFocusCodeError(null)).toBe(false);
    expect(isFocusCodeError(undefined)).toBe(false);
  });
});

describe("new error classes", () => {
  describe("PermissionDeniedError", () => {
    it("exposes tool name and decision", () => {
      const err = new PermissionDeniedError("bash", "deny");
      expect(err.toolName).toBe("bash");
      expect(err.decision).toBe("deny");
      expect(err.name).toBe("PermissionDeniedError");
    });
  });

  describe("SandboxUnavailableError", () => {
    it("exposes sandbox kind and detail", () => {
      const err = new SandboxUnavailableError("docker", "daemon not running");
      expect(err.kind).toBe("docker");
      expect(err.detail).toBe("daemon not running");
      expect(err.name).toBe("SandboxUnavailableError");
    });
  });

  describe("SchemaValidationError", () => {
    it("exposes schema name and reason", () => {
      const err = new SchemaValidationError("task-spec.v1", "missing field");
      expect(err.schema).toBe("task-spec.v1");
      expect(err.reason).toBe("missing field");
      expect(err.name).toBe("SchemaValidationError");
    });
  });

  describe("SessionCorruptedError", () => {
    it("exposes session id and reason", () => {
      const err = new SessionCorruptedError("sess-1", "JSON parse failed");
      expect(err.sessionId).toBe("sess-1");
      expect(err.reason).toBe("JSON parse failed");
      expect(err.name).toBe("SessionCorruptedError");
    });
  });

  describe("ToolExecutionError", () => {
    it("exposes tool name and reason", () => {
      const err = new ToolExecutionError("bash", "exit 1");
      expect(err.toolName).toBe("bash");
      expect(err.reason).toBe("exit 1");
      expect(err.name).toBe("ToolExecutionError");
    });
  });

  describe("TimeoutError", () => {
    it("exposes operation and timeoutMs", () => {
      const err = new TimeoutError("model.complete", 30_000);
      expect(err.operation).toBe("model.complete");
      expect(err.timeoutMs).toBe(30_000);
      expect(err.name).toBe("TimeoutError");
    });
  });

  describe("AbortError", () => {
    it("exposes reason message", () => {
      const err = new AbortError("user aborted");
      expect(err.message).toBe("user aborted");
      expect(err.name).toBe("AbortError");
    });
  });
});

describe("type exports", () => {
  it("exports ErrorCategory, ErrorSeverity, ErrorClassification types", () => {
    const category: ErrorCategory = "model";
    const severity: ErrorSeverity = "error";
    const classification: ErrorClassification = {
      code: "MODEL_HTTP",
      category,
      severity,
      retryable: false,
      failClosed: false,
    };
    expect(classification.code).toBe("MODEL_HTTP");
  });
});
