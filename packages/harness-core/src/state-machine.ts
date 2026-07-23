import type { TaskStateV1 } from "@focuscode/contracts";

const TRANSITIONS: Record<TaskStateV1, ReadonlySet<TaskStateV1>> = {
  CREATED: new Set(["PREFLIGHT", "CANCELLING", "FAILED", "EXPIRED"]),
  PREFLIGHT: new Set(["WAITING_INPUT", "READY", "BLOCKED", "CANCELLING", "FAILED"]),
  WAITING_INPUT: new Set(["READY", "CANCELLING", "CANCELLED", "EXPIRED"]),
  READY: new Set(["RUNNING", "CANCELLING", "FAILED", "EXPIRED"]),
  RUNNING: new Set([
    "WAITING_INPUT",
    "WAITING_APPROVAL",
    "PAUSED",
    "VERIFYING",
    "REVIEW_READY",
    "RECONCILING",
    "BLOCKED",
    "CANCELLING",
    "FAILED",
    "EXPIRED",
  ]),
  WAITING_APPROVAL: new Set(["RUNNING", "CANCELLING", "CANCELLED", "EXPIRED"]),
  PAUSED: new Set(["RUNNING", "CANCELLING", "CANCELLED", "EXPIRED"]),
  VERIFYING: new Set(["RUNNING", "REVIEW_READY", "BLOCKED", "CANCELLING", "FAILED"]),
  REVIEW_READY: new Set(["ACCEPTED", "REJECTED", "RUNNING", "CANCELLING", "EXPIRED"]),
  RECONCILING: new Set(["RUNNING", "BLOCKED", "WAITING_APPROVAL", "FAILED"]),
  BLOCKED: new Set(["RUNNING", "CANCELLING", "CANCELLED", "EXPIRED"]),
  ACCEPTED: new Set([]),
  REJECTED: new Set([]),
  CANCELLING: new Set(["CANCELLED", "BLOCKED", "FAILED"]),
  CANCELLED: new Set([]),
  FAILED: new Set([]),
  EXPIRED: new Set([]),
};

export function assertTransition(from: TaskStateV1, to: TaskStateV1): void {
  if (from === to) return;
  if (!TRANSITIONS[from].has(to)) throw new Error(`Invalid kernel transition: ${from} -> ${to}`);
}

export function isTerminalState(state: TaskStateV1): boolean {
  return ["ACCEPTED", "REJECTED", "CANCELLED", "FAILED", "EXPIRED"].includes(state);
}

export function isQuiescentState(state: TaskStateV1): boolean {
  return (
    isTerminalState(state) ||
    ["WAITING_INPUT", "WAITING_APPROVAL", "PAUSED", "REVIEW_READY", "BLOCKED"].includes(state)
  );
}
