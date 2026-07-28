/**
 * Error code classification (P1-1, review §7).
 *
 * Goal: a single classification surface that maps every well-known
 * FocusCode error (and common anonymous Error instances) onto
 * `{ code, category, severity, retryable, failClosed }` so integrators can
 * build uniform retry / alert / fail-closed logic without sniffing names.
 *
 * The classifier is structural (uses `error.name` rather than `instanceof`)
 * so it works across package boundaries without forcing every consumer to
 * depend on every origin package. Known error classes set `this.name` to a
 * stable string at construction time; we map that string onto a stable
 * classification code.
 *
 * Categories cover every subsystem that emits a typed error today:
 *   auth · model · mcp · permission · sandbox · persistence · protocol ·
 *   circuit · graph · schema · session · tool · timeout · abort · unknown
 *
 * Severity ranks:
 *   fatal  — process/session cannot continue (fail-closed by default)
 *   error  — operation failed; caller decides whether to retry or surface
 *   warning— transient condition (circuit open, rate limit) — retry likely
 *   info   — expected non-success (e.g. abort) — no action needed
 */

import type {
  CircuitOpenError,
  ModelHttpError,
  ModelResponseDriftError,
  McpPinMismatchError,
  GraphCycleError,
  NativeProviderHttpError,
} from "@focuscode/agent-runtime";
import type { McpSchemaChangedError } from "@focuscode/protocols";
import type { OAuthProtocolError } from "@focuscode/auth";
import type { VersionConflictError } from "@focuscode/persistence";

/** Stable subsystem category for a classified error. */
export type ErrorCategory =
  | "auth"
  | "model"
  | "mcp"
  | "permission"
  | "sandbox"
  | "persistence"
  | "protocol"
  | "circuit"
  | "graph"
  | "schema"
  | "session"
  | "tool"
  | "timeout"
  | "abort"
  | "unknown";

/** Severity rank used by integrators to pick a response strategy. */
export type ErrorSeverity = "fatal" | "error" | "warning" | "info";

/** Result of {@link classifyError}. */
export interface ErrorClassification {
  /** Stable, SCREAMING_SNAKE error code (e.g. `MODEL_HTTP`, `CIRCUIT_OPEN`). */
  code: string;
  /** Subsystem category. */
  category: ErrorCategory;
  /** Severity rank. */
  severity: ErrorSeverity;
  /** True if the caller should retry (after backoff if applicable). */
  retryable: boolean;
  /** True if the runtime must fail-closed (refuse to continue). */
  failClosed: boolean;
}

/** Anonymous errors and non-Error values fall back to this classification. */
const UNKNOWN_CLASSIFICATION: ErrorClassification = {
  code: "UNKNOWN",
  category: "unknown",
  severity: "error",
  retryable: false,
  failClosed: false,
};

/** Registry entry type: all classification fields required, code optional. */
interface RegistryEntry {
  code?: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  retryable: boolean;
  failClosed: boolean;
}

/**
 * Map of `error.name` → classification override. Static lookups keep the
 * classifier O(1) and decoupled from package layout. The HTTP-status branch
 * (`MODEL_HTTP`, `MODEL_NATIVE_HTTP`) is handled separately because the
 * retryable flag depends on the status code, not just the name.
 */
const NAME_REGISTRY: Record<string, RegistryEntry> = {
  // auth
  OAuthProtocolError: {
    category: "auth",
    severity: "error",
    retryable: false, // overridden by code-specific check below
    failClosed: false,
  },
  // model — HTTP variants handled in classifyError() for status-aware retry
  ModelResponseDriftError: {
    code: "MODEL_RESPONSE_DRIFT",
    category: "model",
    severity: "error",
    retryable: false,
    failClosed: true,
  },
  // mcp
  McpSchemaChangedError: {
    code: "MCP_SCHEMA_CHANGED",
    category: "mcp",
    severity: "fatal",
    retryable: false,
    failClosed: true,
  },
  McpPinMismatchError: {
    code: "MCP_PIN_MISMATCH",
    category: "mcp",
    severity: "fatal",
    retryable: false,
    failClosed: true,
  },
  // circuit
  CircuitOpenError: {
    code: "CIRCUIT_OPEN",
    category: "circuit",
    severity: "warning",
    retryable: true,
    failClosed: false,
  },
  // persistence
  VersionConflictError: {
    code: "PERSISTENCE_VERSION_CONFLICT",
    category: "persistence",
    severity: "error",
    retryable: false,
    failClosed: false,
  },
  // graph
  GraphCycleError: {
    code: "GRAPH_CYCLE",
    category: "graph",
    severity: "error",
    retryable: false,
    failClosed: false,
  },
  // new SDK error classes (defined below)
  PermissionDeniedError: {
    code: "PERMISSION_DENIED",
    category: "permission",
    severity: "warning",
    retryable: false,
    failClosed: false,
  },
  SandboxUnavailableError: {
    code: "SANDBOX_UNAVAILABLE",
    category: "sandbox",
    severity: "fatal",
    retryable: false,
    failClosed: true,
  },
  SchemaValidationError: {
    code: "SCHEMA_VALIDATION",
    category: "schema",
    severity: "error",
    retryable: false,
    failClosed: false,
  },
  SessionCorruptedError: {
    code: "SESSION_CORRUPTED",
    category: "session",
    severity: "fatal",
    retryable: false,
    failClosed: true,
  },
  ToolExecutionError: {
    code: "TOOL_EXECUTION",
    category: "tool",
    severity: "error",
    retryable: false,
    failClosed: false,
  },
  TimeoutError: {
    code: "TIMEOUT",
    category: "timeout",
    severity: "warning",
    retryable: true,
    failClosed: false,
  },
  AbortError: {
    code: "ABORT",
    category: "abort",
    severity: "info",
    retryable: false,
    failClosed: false,
  },
};

/** OAuth codes that warrant polling retry rather than surface-and-fail. */
const OAUTH_RETRYABLE_CODES = new Set(["authorization_pending", "slow_down"]);

/**
 * Classify an unknown error value onto a stable {@link ErrorClassification}.
 *
 * Behavior:
 *   - Non-Error values (strings, null, undefined) → UNKNOWN.
 *   - `DOMException` with `name === "AbortError"` → ABORT (covers fetch aborts).
 *   - `ModelHttpError`/`NativeProviderHttpError` → status-aware retryable flag
 *     (5xx and 429 retryable; other 4xx non-retryable).
 *   - `OAuthProtocolError` with code `authorization_pending`/`slow_down` retryable.
 *   - Other known names → lookup table.
 *   - Anonymous `Error` → UNKNOWN.
 *
 * The function never throws; passing `null`/`undefined` returns UNKNOWN.
 */
export function classifyError(error: unknown): ErrorClassification {
  if (!error || typeof error !== "object") return { ...UNKNOWN_CLASSIFICATION };

  const name = (error as { name?: unknown }).name;
  if (typeof name !== "string") return { ...UNKNOWN_CLASSIFICATION };

  // Native browser/Node AbortError (DOMException with name "AbortError")
  if (name === "AbortError") {
    const entry = NAME_REGISTRY.AbortError;
    if (!entry) return { ...UNKNOWN_CLASSIFICATION };
    return {
      code: "ABORT",
      category: entry.category,
      severity: entry.severity,
      retryable: entry.retryable,
      failClosed: entry.failClosed,
    };
  }

  // HTTP-status-aware model errors
  if (name === "ModelHttpError" || name === "NativeProviderHttpError") {
    const status = (error as { status?: unknown }).status;
    const retryable = typeof status === "number" && (status >= 500 || status === 429);
    const code = name === "ModelHttpError" ? "MODEL_HTTP" : "MODEL_NATIVE_HTTP";
    return {
      code,
      category: "model",
      severity: retryable ? "warning" : "error",
      retryable,
      failClosed: false,
    };
  }

  // OAuth code-aware retry
  if (name === "OAuthProtocolError") {
    const code = (error as { code?: unknown }).code;
    const retryable = typeof code === "string" && OAUTH_RETRYABLE_CODES.has(code);
    return {
      code: "AUTH_OAUTH_PROTOCOL",
      category: "auth",
      severity: retryable ? "warning" : "error",
      retryable,
      failClosed: false,
    };
  }

  const entry = NAME_REGISTRY[name];
  if (!entry) return { ...UNKNOWN_CLASSIFICATION };
  return {
    code: entry.code ?? name,
    category: entry.category,
    severity: entry.severity,
    retryable: entry.retryable,
    failClosed: entry.failClosed,
  };
}

/** Stable code string for an error (e.g. `CIRCUIT_OPEN`, `UNKNOWN`). */
export function getErrorCode(error: unknown): string {
  return classifyError(error).code;
}

/** True if the classifier thinks the caller should retry. */
export function isRetryable(error: unknown): boolean {
  return classifyError(error).retryable;
}

/** True if the runtime must fail-closed (refuse to continue). */
export function isFailClosed(error: unknown): boolean {
  return classifyError(error).failClosed;
}

/**
 * True if `error` is one of the well-known FocusCode error classes (i.e. the
 * classifier can map it to a non-`UNKNOWN` code). Useful for telemetry filters.
 */
export function isFocusCodeError(error: unknown): boolean {
  return classifyError(error).code !== "UNKNOWN";
}

// ---------------------------------------------------------------------------
// New SDK-level error classes. These fill gaps in the existing error
// taxonomy so the classifier has a target type for every documented category.
// They are intentionally thin: name + message + structured payload, no extra
// behavior. Each sets `this.name` so the structural classifier picks it up
// without `instanceof` across package boundaries.
// ---------------------------------------------------------------------------

/** Raised when a tool call is denied by the permission layer. */
export class PermissionDeniedError extends Error {
  constructor(
    readonly toolName: string,
    readonly decision: string,
  ) {
    super(`Permission denied for ${toolName}: ${decision}`);
    this.name = "PermissionDeniedError";
  }
}

/** Raised when no sandbox executor is available and Host fallback is off. */
export class SandboxUnavailableError extends Error {
  constructor(
    readonly kind: string,
    readonly detail: string,
  ) {
    super(`Sandbox ${kind} unavailable: ${detail}`);
    this.name = "SandboxUnavailableError";
  }
}

/** Raised when a value fails schema validation at a trust boundary. */
export class SchemaValidationError extends Error {
  constructor(
    readonly schema: string,
    readonly reason: string,
  ) {
    super(`Schema ${schema} validation failed: ${reason}`);
    this.name = "SchemaValidationError";
  }
}

/** Raised when a persisted session is unreadable or structurally invalid. */
export class SessionCorruptedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: string,
  ) {
    super(`Session ${sessionId} corrupted: ${reason}`);
    this.name = "SessionCorruptedError";
  }
}

/** Raised when a tool execution fails with a structured error. */
export class ToolExecutionError extends Error {
  constructor(
    readonly toolName: string,
    readonly reason: string,
  ) {
    super(`Tool ${toolName} failed: ${reason}`);
    this.name = "ToolExecutionError";
  }
}

/** Raised when an operation exceeds its time budget. */
export class TimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`Operation ${operation} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/** Raised when an operation is aborted by the caller (not an error). */
export class AbortError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AbortError";
  }
}

// Re-export the imported error types so consumers can construct them from a
// single import site. Type-only re-exports keep runtime size at zero.
export type {
  CircuitOpenError,
  ModelHttpError,
  ModelResponseDriftError,
  McpPinMismatchError,
  GraphCycleError,
  NativeProviderHttpError,
} from "@focuscode/agent-runtime";
export type { McpSchemaChangedError } from "@focuscode/protocols";
export type { OAuthProtocolError } from "@focuscode/auth";
export type { VersionConflictError } from "@focuscode/persistence";
