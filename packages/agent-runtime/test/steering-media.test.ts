import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  CodingAgent,
  SessionStore,
  SteeringQueue,
  imageDataUrl,
  loadImageAttachment,
  loadImageAttachments,
  validateImageAttachment,
  validateImageAttachments,
  type AgentEvent,
  type ModelClient,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
} from "../src/index.js";

const model: ModelProfile = {
  provider: "fixture",
  model: "fixture",
  protocol: "openai-responses",
  baseUrl: "https://fixture",
  authType: "none",
  contextWindow: 16_000,
  maxOutputTokens: 1_000,
  temperature: 0,
  toolMode: "native",
  reasoningEffort: "off",
  capabilities: { input: ["text", "image"], reasoning: false, toolCalling: true },
  compatibility: {},
  reliability: {
    timeoutMs: 300_000,
    maxRetries: 0,
    retryBaseDelayMs: 500,
    retryMaximumDelayMs: 10_000,
  },
};

describe("steering queue", () => {
  it("orders, bounds and drains mid-turn input", () => {
    const queue = new SteeringQueue(2, () => new Date("2026-01-01T00:00:00Z"));
    const first = queue.enqueue("change direction", "interrupt");
    queue.enqueue("also update docs");
    expect(first.id).toMatch(/^steer_/);
    expect(queue.size).toBe(2);
    expect(() => queue.enqueue("overflow")).toThrow("full");
    expect(queue.drain().map((item) => item.text)).toEqual([
      "change direction",
      "also update docs",
    ]);
    expect(queue.size).toBe(0);
  });

  it("holds follow-up input until the current agent work reaches a final response", async () => {
    const root = await createTestDirectory("followup-agent");
    let started!: () => void;
    let release!: () => void;
    const generating = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: ModelRequest[] = [];
    const client: ModelClient = {
      protocol: "fixture",
      async complete(request): Promise<ModelResponse> {
        requests.push(request);
        if (requests.length === 1) {
          started();
          await blocked;
          return {
            content: "Initial work is complete.",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "stop",
          };
        }
        return {
          content: "Follow-up is complete.",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "stop",
        };
      },
    };
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: client,
      tools: [],
      permission: { mode: "deny", projectTrusted: false, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
    });
    const running = agent.submit("Start the task");
    await generating;
    await agent.steer("Now write the release note", "follow-up");
    release();
    await expect(running).resolves.toMatchObject({ content: "Follow-up is complete." });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Start the task"],
      ["assistant", "Initial work is complete."],
      ["user", "Now write the release note"],
    ]);
  });

  it("interrupts active generation, persists steering and resumes the same run", async () => {
    const root = await createTestDirectory("steering-agent");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const requests: ModelRequest[] = [];
    let call = 0;
    const client: ModelClient = {
      protocol: "fixture",
      async complete(request): Promise<ModelResponse> {
        requests.push(request);
        call += 1;
        if (call === 1) {
          markStarted();
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new DOMException("Interrupted", "AbortError");
        }
        return {
          content: "Applied the steering instruction.",
          toolCalls: [],
          usage: { inputTokens: 2, outputTokens: 3 },
          stopReason: "stop",
        };
      },
    };
    const events: AgentEvent[] = [];
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: client,
      tools: [],
      permission: {
        mode: "deny",
        projectTrusted: false,
        protectedPaths: [],
      },
      sessionStore: new SessionStore("unused", false),
      eventSink: (event) => events.push(event),
    });
    const running = agent.submit("Initial request");
    await started;
    const receipt = await agent.steer("Use the simpler design", "interrupt");
    expect(receipt.queueSize).toBe(1);
    const result = await running;
    expect(result.content).toBe("Applied the steering instruction.");
    expect(requests).toHaveLength(2);
    expect(
      requests[1]?.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["Initial request", "Use the simpler design"]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["steering_queued", "steering_applied"]),
    );
  });

  it("removes queued steering by id or latest-first", () => {
    const queue = new SteeringQueue(4, () => new Date("2026-01-01T00:00:00Z"));
    const first = queue.enqueue("first", "append");
    const second = queue.enqueue("second", "follow-up");
    const third = queue.enqueue("third", "interrupt");
    expect(queue.remove(second.id)).toMatchObject({ id: second.id, text: "second" });
    expect(queue.remove("steer_missing")).toBeUndefined();
    expect(queue.removeLatest("interrupt")).toMatchObject({ id: third.id });
    expect(queue.removeLatest("interrupt")).toBeUndefined();
    expect(queue.removeLatest()).toMatchObject({ id: first.id });
    expect(queue.size).toBe(0);
  });

  it("drains one matching item at a time in fifo order", () => {
    const queue = new SteeringQueue(4, () => new Date("2026-01-01T00:00:00Z"));
    queue.enqueue("first", "follow-up");
    queue.enqueue("second", "append");
    queue.enqueue("third", "append");
    expect(queue.drainOne(["append"])?.text).toBe("second");
    expect(queue.drainOne()?.text).toBe("first");
    expect(queue.drainOne()?.text).toBe("third");
    expect(queue.drainOne()).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it("unsteer removes queued steering and emits steering_removed with the queue size", async () => {
    const root = await createTestDirectory("unsteer-agent");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: ModelClient = {
      protocol: "fixture",
      async complete(): Promise<ModelResponse> {
        markStarted();
        await blocked;
        return {
          content: "Done without steering.",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "stop",
        };
      },
    };
    const events: AgentEvent[] = [];
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: client,
      tools: [],
      permission: { mode: "deny", projectTrusted: false, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      eventSink: (event) => events.push(event),
    });
    const running = agent.submit("Start the task");
    await started;
    const first = await agent.steer("first nudge", "append");
    await agent.steer("second nudge", "append");
    expect(agent.listSteering().map((item) => item.text)).toEqual(["first nudge", "second nudge"]);
    const removed = await agent.unsteer(first.id);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ id: first.id, text: "first nudge" });
    const latest = await agent.unsteer();
    expect(latest).toHaveLength(1);
    expect(latest[0]?.text).toBe("second nudge");
    expect(agent.listSteering()).toHaveLength(0);
    await expect(agent.unsteer()).resolves.toEqual([]);
    const removedEvents = events.filter((event) => event.type === "steering_removed");
    expect(removedEvents).toHaveLength(2);
    expect(removedEvents[0]).toMatchObject({ ids: [first.id], queueSize: 1 });
    expect(removedEvents[1]).toMatchObject({ queueSize: 0 });
    release();
    await expect(running).resolves.toMatchObject({ content: "Done without steering." });
  });

  it("applies one steering item per round when delivery is one-at-a-time", async () => {
    const root = await createTestDirectory("steering-one-at-a-time");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: ModelRequest[] = [];
    const client: ModelClient = {
      protocol: "fixture",
      async complete(request): Promise<ModelResponse> {
        requests.push(request);
        if (requests.length === 1) {
          markStarted();
          await blocked;
        }
        return {
          content: "Response " + requests.length,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "stop",
        };
      },
    };
    const events: AgentEvent[] = [];
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: client,
      tools: [],
      permission: { mode: "deny", projectTrusted: false, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      steeringDelivery: "one-at-a-time",
      eventSink: (event) => events.push(event),
    });
    const running = agent.submit("Start the task");
    await started;
    const first = await agent.steer("append1");
    const second = await agent.steer("append2");
    release();
    const result = await running;
    expect(result.content).toBe("Response 3");
    expect(requests).toHaveLength(3);
    expect(requests[1]?.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Start the task"],
      ["assistant", "Response 1"],
      ["user", "append1"],
    ]);
    expect(requests[2]?.messages.at(-1)).toMatchObject({ role: "user", content: "append2" });
    const applied = events.filter((event) => event.type === "steering_applied");
    expect(applied).toHaveLength(2);
    expect(applied[0]).toMatchObject({ ids: [first.id], queueSize: 1 });
    expect(applied[1]).toMatchObject({ ids: [second.id], queueSize: 0 });
  });
});

describe("multimodal attachment loading", () => {
  it("loads and validates local PNG files and HTTPS URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "focus-media-"));
    const png = join(root, "screen.png");
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const attachment = await loadImageAttachment("screen.png", { cwd: root });
    expect(attachment).toMatchObject({ mediaType: "image/png", name: "screen.png" });
    expect(imageDataUrl(attachment)).toMatch(/^data:image\/png;base64,/);
    expect(validateImageAttachment(attachment)).toEqual(attachment);
    expect(validateImageAttachments([attachment])).toHaveLength(1);
    const remote = await loadImageAttachment("https://example.com/design.webp", { cwd: root });
    expect(remote.source).toEqual({ type: "url", url: "https://example.com/design.webp" });
    expect(await loadImageAttachments(["screen.png"], { cwd: root })).toHaveLength(1);
    await expect(
      loadImageAttachment("https://example.com/private.png", {
        cwd: root,
        allowRemoteUrls: false,
      }),
    ).rejects.toThrow("disabled by policy");
  });

  it("blocks invalid images, unsupported schemes and workspace escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "focus-media-root-"));
    const outside = await mkdtemp(join(tmpdir(), "focus-media-outside-"));
    await writeFile(join(root, "text.png"), "not an image");
    await writeFile(
      join(outside, "outside.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    await expect(loadImageAttachment("text.png", { cwd: root })).rejects.toThrow("invalid");
    await expect(loadImageAttachment("http://example.com/a.png", { cwd: root })).rejects.toThrow(
      "Only HTTPS",
    );
    await expect(loadImageAttachment(join(outside, "outside.png"), { cwd: root })).rejects.toThrow(
      "escapes",
    );
    await mkdir(join(root, "many"));
    await expect(
      loadImageAttachments(
        Array.from({ length: 11 }, () => "text.png"),
        { cwd: root },
      ),
    ).rejects.toThrow("At most");
    const valid = await loadImageAttachment(join(outside, "outside.png"), {
      cwd: root,
      allowOutsideWorkspace: true,
    });
    expect(() =>
      validateImageAttachment({
        ...valid,
        source: { type: "base64", data: "not-base64" },
      }),
    ).toThrow("base64");
  });
});
