import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * End-to-end integration test.
 *
 * Spins up a loopback OTLP/HTTP sink, loads the real index.ts extension
 * against a fake ExtensionAPI pointed at that sink, replays a realistic
 * session's event sequence, and asserts that the produced OTLP payloads
 * (traces, metrics, logs) actually arrive over HTTP with the expected span
 * names embedded.
 *
 * This is the highest-fidelity test short of running pi itself: it exercises
 * config -> sdk -> exporter -> HTTP -> our assertions, end to end.
 */

const SINK_PORT = 14318; // avoid 4318 in case the user has jaeger running
const ENDPOINT = `http://127.0.0.1:${SINK_PORT}`;

let server: Server;
const received = { traces: [] as Buffer[], metrics: [] as Buffer[], logs: [] as Buffer[] };
const savedEnv: Record<string, string | undefined> = {};
const E2E_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "PI_OTEL_DISABLED",
] as const;

before(async () => {
  for (const k of E2E_ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const url = req.url ?? "";
      if (url.endsWith("/v1/traces")) received.traces.push(buf);
      else if (url.endsWith("/v1/metrics")) received.metrics.push(buf);
      else if (url.endsWith("/v1/logs")) received.logs.push(buf);
      // Connection: close forces the exporter's keep-alive agent to release the
      // socket after each export, so server.close() in after() can complete
      // instead of waiting on idle keep-alive connections forever.
      res.writeHead(200, { "Content-Type": "application/x-protobuf", Connection: "close" });
      res.end(Buffer.alloc(0));
    });
  });
  await new Promise<void>((resolve) => server.listen(SINK_PORT, "127.0.0.1", resolve));
});

after(async () => {
  // closeAllConnections drops any lingering keep-alive sockets before close().
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of E2E_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function resetReceived() {
  received.traces = []; received.metrics = []; received.logs = [];
}

/** Extract printable strings >= 6 chars from a (likely protobuf) buffer. */
function stringsIn(buf: Buffer): string[] {
  return (buf.toString("latin1").match(/[\x20-\x7e]{6,}/g) ?? []);
}

// --- fake ExtensionAPI ------------------------------------------------------

function fakePi() {
  const handlers = new Map<string, (e: any, ctx: any) => any>();
  const commands = new Map<string, { handler: (a: string, c: any) => any }>();
  const eventListeners = new Map<string, Array<(d: unknown) => void>>();
  const ctx = {
    cwd: "/e2e",
    hasUI: false,
    model: { id: "test-model", provider: "test" },
    signal: undefined as AbortSignal | undefined,
    sessionManager: { getSessionFile: () => "/tmp/e2e.jsonl" },
    ui: { notify: () => {}, setStatus: () => {} },
  };
  const pi = {
    on(event: string, h: (e: any, c: any) => any) { handlers.set(event, h); },
    registerCommand(name: string, opts: { handler: (a: string, c: any) => any }) { commands.set(name, opts); },
    registerTool() {}, registerShortcut() {}, registerFlag() {},
    events: {
      on(ch: string, fn: (d: unknown) => void) { (eventListeners.get(ch) ?? eventListeners.set(ch, []).get(ch)!).push(fn); },
      emit(ch: string, d: unknown) { for (const fn of eventListeners.get(ch) ?? []) fn(d); },
    },
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, ctx };
}

describe("end-to-end over real HTTP OTLP", () => {
  test("a full prompt with a tool call exports traces, metrics, and logs", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "500";
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "read the file", systemPrompt: "" });
    await emit("agent_start", {});
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("message_start", { message: { role: "user", content: "read the file" } });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } }], model: "test-model", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, stopReason: "tool_use" },
      toolResults: [],
    });
    await emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
    await emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "/x" } });
    await emit("before_provider_request", { payload: {} });
    await emit("tool_execution_end", { toolCallId: "t1", toolName: "read", result: { out: "contents" }, isError: false });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 1,
      message: { role: "assistant", content: [{ type: "text", text: "done" }], model: "test-model", usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } }, stopReason: "stop" },
      toolResults: [],
    });
    await emit("agent_end", { messages: [] });
    await emit("session_shutdown", { reason: "quit" });

    // Traces and logs export synchronously on shutdown; metrics on the 500ms tick.
    assert.ok(received.traces.length > 0, "traces exported");
    assert.ok(received.logs.length > 0, "logs exported");
    // metrics may flush on shutdown's forceFlush
    assert.ok(received.metrics.length > 0, "metrics exported");

    // The trace payload must contain the documented span names.
    const allTraceStrings = received.traces.flatMap(stringsIn);
    assert.ok(allTraceStrings.some(s => s.includes("pi.session")), "pi.session span");
    assert.ok(allTraceStrings.some(s => s.includes("pi.interaction")), "pi.interaction span");
    assert.ok(allTraceStrings.some(s => s.includes("pi.turn")), "pi.turn span");
    assert.ok(allTraceStrings.some(s => s.includes("pi.llm_request")), "pi.llm_request span");
    assert.ok(allTraceStrings.some(s => s.includes("pi.tool.read")), "pi.tool.read span");
    // gen_ai.system attribute
    assert.ok(allTraceStrings.some(s => s.includes("gen_ai.system")), "gen_ai.system attr");
    assert.ok(allTraceStrings.some(s => s.includes("test-model")), "request model attr");

    // Logs must include the session lifecycle event.
    const allLogStrings = received.logs.flatMap(stringsIn);
    assert.ok(allLogStrings.some(s => s.includes("pi.session")), "session lifecycle log");
  });

  test("session replacement does not error and still exports on shutdown", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "p1", systemPrompt: "" });
    await emit("turn_start", { turnIndex: 0, timestamp: 0 });
    await emit("before_provider_request", { payload: {} });
    // session replaced mid-flight
    await emit("session_before_switch", { reason: "new" });
    await emit("session_shutdown", { reason: "new" });

    assert.ok(received.traces.length > 0, "traces exported despite mid-flight replacement");
    // No throw is the implicit pass condition above.
  });

  test("sequential non-quit sessions each export; first runtime is fully shut down", async () => {
    // Locks the always-shutdown path: after session_shutdown(reason=new) the
    // previous providers must not keep exporting. A second session starts a
    // fresh runtime and its own exports land independently.
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    // Session A: one span tree, shut down with non-quit reason.
    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "session-a", systemPrompt: "" });
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    });
    await emit("agent_end", { messages: [] });
    await emit("session_shutdown", { reason: "new" });
    const afterA = received.traces.length;
    assert.ok(afterA > 0, "session A exported traces on non-quit shutdown");
    const aBlob = received.traces.map(b => b.toString("latin1")).join("");
    assert.ok(aBlob.includes("session-a") || aBlob.includes("pi.session"), "session A payload present");

    // After A is shut down, no further spontaneous exports should arrive.
    const mid = received.traces.length;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(received.traces.length, mid, "no zombie exports after session A shutdown");

    // Session B: fresh runtime, independent export.
    await emit("session_start", { reason: "new" });
    await emit("before_agent_start", { prompt: "session-b", systemPrompt: "" });
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "b" }],
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    });
    await emit("agent_end", { messages: [] });
    await emit("session_shutdown", { reason: "quit" });
    assert.ok(received.traces.length > afterA, "session B exported additional traces");
  });

  test("disabled via PI_OTEL_DISABLED=1 exports nothing", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    process.env.PI_OTEL_DISABLED = "1";
    try {
      const { pi, handlers, ctx } = fakePi();
      const mod = await import("../src/index.ts");
      mod.default(pi);
      const emit = async (event: string, payload: any) => {
        const h = handlers.get(event);
        if (h) await h({ type: event, ...payload }, ctx);
      };
      await emit("session_start", { reason: "startup" });
      await emit("before_agent_start", { prompt: "x", systemPrompt: "" });
      await emit("agent_end", { messages: [] });
      await emit("session_shutdown", { reason: "quit" });
      assert.equal(received.traces.length, 0, "no traces when disabled");
      assert.equal(received.logs.length, 0, "no logs when disabled");
      assert.equal(received.metrics.length, 0, "no metrics when disabled");
    } finally {
      delete process.env.PI_OTEL_DISABLED;
    }
  });

  test("lifecycle log events include session end, llm error, and tool error", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "do a thing", systemPrompt: "" });
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 500, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
        model: "m",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "tool_use",
      },
    });
    await emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
    await emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: {} });
    await emit("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: "err", isError: true });
    await emit("agent_end", { messages: [] });
    await emit("session_shutdown", { reason: "quit" });

    assert.ok(received.logs.length > 0, "logs exported");
    const allLogStrings = received.logs.flatMap(stringsIn);
    assert.ok(allLogStrings.some(s => s.includes("pi.session.start")), "pi.session.start");
    assert.ok(allLogStrings.some(s => s.includes("pi.session.end")), "pi.session.end emitted on shutdown");
    assert.ok(allLogStrings.some(s => s.includes("pi.llm_request.error")), "pi.llm_request.error on HTTP >=400");
    assert.ok(allLogStrings.some(s => s.includes("pi.tool.error")), "pi.tool.error on failed tool");
  });
});

void basename;
