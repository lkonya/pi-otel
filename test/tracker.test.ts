import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  ATTR_GEN_AI_INPUT_TOKENS,
  ATTR_GEN_AI_OUTPUT_TOKENS,
  ATTR_GEN_AI_CACHE_READ_TOKENS,
  ATTR_GEN_AI_CACHE_WRITE_TOKENS,
  ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS,
  ATTR_GEN_AI_COST_USD,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_HTTP_STATUS_CODE,
  ATTR_PI_SESSION_ID,
  ATTR_PI_SESSION_REASON,
  ATTR_PI_TURN_INDEX,
  ATTR_PI_TOOL_IS_ERROR,
  ATTR_PI_CANCELLED,
  ATTR_PI_ORPHANED,
  ATTR_PI_INTERACTION_ID,
  SPAN_SESSION,
  SPAN_INTERACTION,
  SPAN_TURN,
  SPAN_LLM_REQUEST,
} from "../src/attrs.ts";
import { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { configureCapture, SpanTracker } from "../src/tracker.ts";
import { makeHarness, asstMsg, recordingMetricsOf, RecordingMetrics, type Harness } from "./helpers.ts";

/**
 * SpanTracker lifecycle tests.
 *
 * Strategy: drive the tracker through synthetic event sequences (the same
 * sequence Pi would fire) and assert on the spans that land in the in-memory
 * exporter. Each test gets a fresh harness.
 */

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  await h.flush();
  configureCapture("full"); // restore default for other test files
});

// A canonical "happy path" interaction: one prompt, one turn, one LLM call,
// one tool call, then clean completion.
function runHappyPath(h: Harness, opts: { tool?: boolean } = {}): void {
  h.tracker.startSession();
  h.tracker.startInteraction("hello pi");
  h.tracker.startTurn(0);
  h.tracker.startLlm("claude-4", "anthropic");
  h.tracker.noteUserInput("hello pi");
  h.tracker.recordProviderResponse(200, {});
  if (opts.tool) {
    // Tool runs after the LLM response with the tool call.
    h.tracker.startTool("call_1", "bash", { command: "ls" });
    h.tracker.endTool("call_1", false, { output: "file.txt" });
  }
  h.tracker.completeLlm(asstMsg({ text: "hi", stopReason: opts.tool ? "tool_use" : "stop" }) as never);
  h.tracker.endTurn();
  h.tracker.endInteraction();
  h.tracker.endSession();
}

describe("span tree shape", () => {
  test("happy path emits session, interaction, turn, llm_request spans", async () => {
    runHappyPath(h);
    await h.flush();
    const names = Object.keys(h.spansByName());
    assert.ok(names.includes(SPAN_SESSION), `has ${SPAN_SESSION}: ${names.join(",")}`);
    assert.ok(names.includes(SPAN_INTERACTION));
    assert.ok(names.includes(SPAN_TURN));
    assert.ok(names.includes(SPAN_LLM_REQUEST));
  });

  test("llm_request is a CLIENT span (gen_ai convention)", async () => {
    runHappyPath(h);
    await h.flush();
    assert.equal(h.spansByName()[SPAN_LLM_REQUEST].kind, SpanKind.CLIENT);
  });

  test("session/interaction/turn are INTERNAL kind", async () => {
    runHappyPath(h);
    await h.flush();
    assert.equal(h.spansByName()[SPAN_SESSION].kind, SpanKind.INTERNAL);
    assert.equal(h.spansByName()[SPAN_INTERACTION].kind, SpanKind.INTERNAL);
    assert.equal(h.spansByName()[SPAN_TURN].kind, SpanKind.INTERNAL);
  });

  test("turn is a child of interaction, interaction of session", async () => {
    runHappyPath(h);
    await h.flush();
    const spans = h.spansByName();
    assert.equal(spans[SPAN_TURN].parentSpanContext?.spanId, spans[SPAN_INTERACTION].spanContext().spanId);
    assert.equal(spans[SPAN_INTERACTION].parentSpanContext?.spanId, spans[SPAN_SESSION].spanContext().spanId);
  });

  test("tool span is a child of turn (sibling of llm_request, not child of it)", async () => {
    runHappyPath(h, { tool: true });
    await h.flush();
    const spans = h.spansByName();
    const tool = spans["pi.tool.bash"];
    const turn = spans[SPAN_TURN];
    const llm = spans[SPAN_LLM_REQUEST];
    assert.ok(tool, "tool span present");
    assert.equal(tool.parentSpanContext?.spanId, turn.spanContext().spanId, "tool parented under turn");
    assert.notEqual(tool.parentSpanContext?.spanId, llm.spanContext().spanId, "tool NOT parented under llm");
  });
});

describe("common attributes", () => {
  test("every span carries gen_ai.system=pi", async () => {
    runHappyPath(h);
    await h.flush();
    for (const span of Object.values(h.spansByName())) {
      assert.equal(span.attributes[ATTR_GEN_AI_SYSTEM], "pi", `${span.name} missing gen_ai.system`);
    }
  });

  test("every span carries pi.session.id", async () => {
    runHappyPath(h);
    await h.flush();
    for (const span of Object.values(h.spansByName())) {
      assert.equal(span.attributes[ATTR_PI_SESSION_ID], "test-session", `${span.name} missing session.id`);
    }
  });

  test("turn carries turn.index", async () => {
    runHappyPath(h);
    await h.flush();
    assert.equal(h.spansByName()[SPAN_TURN].attributes[ATTR_PI_TURN_INDEX], 0);
  });

  test("interaction carries interaction.id", async () => {
    runHappyPath(h);
    await h.flush();
    assert.equal(h.spansByName()[SPAN_INTERACTION].attributes[ATTR_PI_INTERACTION_ID], 1);
  });
});

describe("session start reason", () => {
  test("startSession(fork) sets pi.session.reason on session span", async () => {
    h.tracker.startSession("fork");
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.spansByName()[SPAN_SESSION].attributes[ATTR_PI_SESSION_REASON], "fork");
  });

  test("startSession() with no reason omits pi.session.reason", async () => {
    h.tracker.startSession();
    h.tracker.endSession();
    await h.flush();
    const attrs = h.spansByName()[SPAN_SESSION].attributes;
    assert.equal(ATTR_PI_SESSION_REASON in attrs, false);
  });
});

// ---------------------------------------------------------------------------
// Semconv usage attribution — the most important correctness property.
// ---------------------------------------------------------------------------

describe("llm usage attribution", () => {
  test("records all token type attributes including cache_write_1h", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.completeLlm(asstMsg({
      input: 100, output: 50, cacheRead: 30, cacheWrite: 20, cacheWrite1h: 5, cost: 0.012,
      stopReason: "stop",
    }) as never);
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const a = h.spansByName()[SPAN_LLM_REQUEST].attributes;
    assert.equal(a[ATTR_GEN_AI_INPUT_TOKENS], 100);
    assert.equal(a[ATTR_GEN_AI_OUTPUT_TOKENS], 50);
    assert.equal(a[ATTR_GEN_AI_CACHE_READ_TOKENS], 30);
    assert.equal(a[ATTR_GEN_AI_CACHE_WRITE_TOKENS], 20);
    assert.equal(a[ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS], 5, "cache_write_1h must be captured (Anthropic 1h split)");
    assert.equal(a[ATTR_GEN_AI_COST_USD], 0.012);
  });

  test("omits cache_write_1h attribute when not reported", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.completeLlm(asstMsg({ cacheWrite: 10, stopReason: "stop" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const a = h.spansByName()[SPAN_LLM_REQUEST].attributes;
    assert.equal(ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS in a, false, "must not set 1h attr when undefined");
    assert.equal(a[ATTR_GEN_AI_CACHE_WRITE_TOKENS], 10);
  });

  test("records request and response model", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4-sonnet", "anthropic");
    h.tracker.completeLlm(asstMsg({ responseModel: "claude-4-sonnet-20250514", stopReason: "stop" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const a = h.spansByName()[SPAN_LLM_REQUEST].attributes;
    assert.equal(a[ATTR_GEN_AI_REQUEST_MODEL], "claude-4-sonnet");
    assert.equal(a[ATTR_GEN_AI_RESPONSE_MODEL], "claude-4-sonnet-20250514");
  });

  test("captures finish reason as an array per semconv", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({ stopReason: "end_turn" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    assert.deepEqual(h.spansByName()[SPAN_LLM_REQUEST].attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS], ["end_turn"]);
  });

  test("sets ERROR status on finishReason=error and records message", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({ stopReason: "error", errorMessage: "rate limited" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const span = h.spansByName()[SPAN_LLM_REQUEST];
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.status.message, "rate limited");
  });

  test("captures response.id from message, not headers", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(200, { "x-request-id": "from-header" });
    h.tracker.completeLlm(asstMsg({ responseId: "from-message", stopReason: "stop" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    // message.responseId (set in completeLlm) overwrites the header-derived value.
    assert.equal(h.spansByName()[SPAN_LLM_REQUEST].attributes[ATTR_GEN_AI_RESPONSE_ID], "from-message");
  });

  test("records http.response.status_code from provider response", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(429, {});
    h.tracker.completeLlm(asstMsg({ stopReason: "error" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const a = h.spansByName()[SPAN_LLM_REQUEST].attributes;
    assert.equal(a[ATTR_HTTP_STATUS_CODE], 429);
  });

  test("sets error.type and ERROR status on HTTP >= 400", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(500, {});
    h.tracker.completeLlm(asstMsg({ stopReason: "error" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const span = h.spansByName()[SPAN_LLM_REQUEST];
    assert.equal(span.attributes["error.type"], "http_500");
    assert.equal(span.status.code, SpanStatusCode.ERROR);
  });
});

describe("llm metrics", () => {
  test("records op duration, input tokens, output tokens", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.completeLlm(asstMsg({ input: 100, output: 50, stopReason: "stop" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    assert.ok(h.metrics.histograms["op"]?.length === 1, "op duration recorded");
    const tokenRecs = h.metrics.histograms["tokens"] ?? [];
    assert.equal(tokenRecs.length, 2, "one input + one output record");
    const byType = Object.fromEntries(tokenRecs.map(r => [r.attrs["gen_ai.token.type"], r.value]));
    assert.equal(byType.input, 100);
    assert.equal(byType.output, 50);
  });

  test("records provider retry on second response event", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(429, {}); // attempt 1
    h.tracker.recordProviderResponse(200, {}); // attempt 2 -> retry
    h.tracker.completeLlm(asstMsg({ stopReason: "stop" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    assert.equal(h.metrics.counters["retries"]?.length, 1, "one retry counted");
  });
});

// ---------------------------------------------------------------------------
// Tool spans
// ---------------------------------------------------------------------------

describe("tool spans", () => {
  test("carry gen_ai.tool.name, call.id, and is_error", async () => {
    runHappyPath(h, { tool: true });
    await h.flush();
    const a = h.spansByName()["pi.tool.bash"].attributes;
    assert.equal(a[ATTR_GEN_AI_TOOL_NAME], "bash");
    assert.equal(a[ATTR_GEN_AI_TOOL_CALL_ID], "call_1");
    assert.equal(a[ATTR_PI_TOOL_IS_ERROR], false);
  });

  test("ERROR status when tool fails", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startTool("t1", "bash", { command: "bad" });
    h.tracker.endTool("t1", true, { error: "exit 1" });
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const span = h.spansByName()["pi.tool.bash"];
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.attributes["error.type"], "tool_error");
  });

  test("increments tool.calls counter per tool", async () => {
    runHappyPath(h, { tool: true });
    const recs = h.metrics.counters["toolcalls"] ?? [];
    assert.equal(recs.length, 1);
    assert.equal(recs[0].attrs[ATTR_GEN_AI_TOOL_NAME], "bash");
  });

  test("unknown toolCallId on endTool is a safe no-op", async () => {
    h.tracker.startSession();
    h.tracker.startTool("real", "bash", {});
    h.tracker.endTool("nonexistent", false, {}); // should not throw
    h.tracker.endSession();
    await h.flush();
    assert.ok(h.spansByName()["pi.tool.bash"], "real tool span still present");
  });

  test("tool span links to open llm_request span", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.startTool("call_1", "bash", { command: "ls" });
    h.tracker.endTool("call_1", false, { output: "file.txt" });
    h.tracker.completeLlm(asstMsg({ stopReason: "tool_use" }) as never);
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const spans = h.spansByName();
    const tool = spans["pi.tool.bash"];
    const llm = spans[SPAN_LLM_REQUEST];
    assert.ok(tool, "tool span present");
    assert.ok(llm, "llm span present");
    assert.equal(tool.links.length, 1);
    assert.equal(tool.links[0].context.traceId, llm.spanContext().traceId);
    assert.equal(tool.links[0].context.spanId, llm.spanContext().spanId);
  });

  test("tool span has no links when llm_request is not open", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startTool("t1", "bash", { command: "bad" });
    h.tracker.endTool("t1", false, {});
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const tool = h.spansByName()["pi.tool.bash"];
    assert.ok(tool, "tool span present");
    assert.equal(tool.links.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Cancellation (Esc / abort)
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  test("markCancelled sets pi.cancelled on active spans", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.startTool("t1", "bash", {});
    h.tracker.markCancelled();
    h.tracker.endTool("t1", false, {});
    h.tracker.endLlm({ reason: "cancel" } as never);
    h.tracker.endTurn({ cancelled: true });
    h.tracker.endInteraction({ cancelled: true });
    h.tracker.endSession();
    await h.flush();
    const spans = h.spansByName();
    assert.equal(spans[SPAN_LLM_REQUEST].attributes[ATTR_PI_CANCELLED], true);
    assert.equal(spans["pi.tool.bash"].attributes[ATTR_PI_CANCELLED], true);
    assert.equal(spans[SPAN_TURN].attributes[ATTR_PI_CANCELLED], true);
  });

  test("increments turn.cancellations metric when turn ends cancelled", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.endTurn({ cancelled: true });
    h.tracker.endInteraction();
    h.tracker.endSession();
    assert.equal(h.metrics.counters["cancels"]?.length, 1);
  });

  test("finishReason=aborted marks llm span cancelled", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({ stopReason: "aborted" }) as never);
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    assert.equal(h.spansByName()[SPAN_LLM_REQUEST].attributes[ATTR_PI_CANCELLED], true);
    assert.equal(h.spansByName()[SPAN_LLM_REQUEST].status.code, SpanStatusCode.ERROR);
  });
});

// ---------------------------------------------------------------------------
// Orphan hygiene — the bug class that affects session replacement flows.
// ---------------------------------------------------------------------------

describe("orphan hygiene", () => {
  test("endInteraction closes any open llm/tool/turn spans", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.startTool("t1", "bash", {});
    // Abandon mid-flight — endInteraction must close everything.
    h.tracker.endInteraction({ reason: "session_switch" });
    h.tracker.endSession();
    await h.flush();
    const spans = h.spansByName();
    assert.equal(spans[SPAN_LLM_REQUEST].ended, true);
    assert.equal(spans["pi.tool.bash"].ended, true);
    assert.equal(spans[SPAN_TURN].ended, true);
  });

  test("ending an interaction mid-flight marks it orphaned", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.endInteraction({ reason: "session_switch" });
    h.tracker.endSession();
    await h.flush();
    // The orphaned interaction/turn/llm spans get the pi.orphaned marker.
    const interaction = h.spansByName()[SPAN_INTERACTION];
    assert.equal(interaction.attributes[ATTR_PI_ORPHANED], true, "interaction marked orphaned");
  });

  test("starting a new interaction closes the previous one", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("first");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    // Second prompt arrives without clean closure of the first.
    h.tracker.startInteraction("second");
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    // Both interactions must be ended (no leak).
    const interactionSpans = h.spanExporter.getFinishedSpans().filter(s => s.name === SPAN_INTERACTION);
    assert.equal(interactionSpans.length, 2);
    assert.ok(interactionSpans.every(s => s.ended));
  });

  test("endSession closes any still-open spans", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.startTool("t1", "bash", {});
    // Quit mid-flight.
    h.tracker.endSession();
    await h.flush();
    for (const span of h.spanExporter.getFinishedSpans()) {
      assert.equal(span.ended, true, `${span.name} not ended`);
    }
  });

  test("metrics: prompt.count increments on each interaction", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("a");
    h.tracker.endInteraction();
    h.tracker.startInteraction("b");
    h.tracker.endInteraction();
    h.tracker.endSession();
    assert.equal(h.metrics.counters["prompts"]?.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Content capture modes
// ---------------------------------------------------------------------------

describe("content capture modes", () => {
  test("metadata_only emits no raw user prompt", async () => {
    const h2 = makeHarness({ captureContent: "metadata_only" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("secret-prompt-content");
    h2.tracker.endInteraction();
    h2.tracker.endSession();
    await h2.flush();
    const attrs = h2.spansByName()[SPAN_INTERACTION].attributes;
    assert.equal("pi.user_prompt" in attrs, false, "no raw prompt");
    // fingerprint present instead
    assert.ok("pi.user_prompt.bytes" in attrs, "fingerprint bytes present");
  });

  test("full emits raw user prompt", async () => {
    const h2 = makeHarness({ captureContent: "full" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("secret-prompt-content");
    h2.tracker.endInteraction();
    h2.tracker.endSession();
    await h2.flush();
    assert.equal(h2.spansByName()[SPAN_INTERACTION].attributes["pi.user_prompt"], "secret-prompt-content");
  });

  test("no_tool_content emits prompt but not tool args", async () => {
    const h2 = makeHarness({ captureContent: "no_tool_content" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("the-prompt");
    h2.tracker.startTurn(0);
    h2.tracker.startLlm("m", "p");
    h2.tracker.startTool("t1", "bash", { command: "secret-cmd" });
    h2.tracker.endTool("t1", false, { out: "secret-out" });
    h2.tracker.completeLlm(asstMsg({ text: "the-completion" }) as never);
    h2.tracker.endTurn(); h2.tracker.endInteraction(); h2.tracker.endSession();
    await h2.flush();
    const spans = h2.spansByName();
    // prompt captured
    assert.equal(spans[SPAN_INTERACTION].attributes["pi.user_prompt"], "the-prompt");
    // tool args/result NOT captured
    assert.equal(ATTR_GEN_AI_TOOL_CALL_ARGUMENTS in spans["pi.tool.bash"].attributes, false);
    assert.equal(ATTR_GEN_AI_TOOL_CALL_RESULT in spans["pi.tool.bash"].attributes, false);
  });

  test("full captures tool args and result", async () => {
    const h2 = makeHarness({ captureContent: "full" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("p");
    h2.tracker.startTurn(0);
    h2.tracker.startLlm("m", "p");
    h2.tracker.startTool("t1", "bash", { command: "ls" });
    h2.tracker.endTool("t1", false, { out: "x" });
    h2.tracker.completeLlm(asstMsg({}) as never);
    h2.tracker.endTurn(); h2.tracker.endInteraction(); h2.tracker.endSession();
    await h2.flush();
    const a = h2.spansByName()["pi.tool.bash"].attributes;
    assert.ok(a[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]);
    assert.ok(a[ATTR_GEN_AI_TOOL_CALL_RESULT]);
  });
});

// ---------------------------------------------------------------------------
// Idempotency / defensive behavior
// ---------------------------------------------------------------------------

describe("defensive behavior", () => {
  test("endSession is idempotent (calling twice does not throw or duplicate)", async () => {
    h.tracker.startSession();
    h.tracker.endSession();
    h.tracker.endSession(); // second call must not throw
    await h.flush();
    const sessionSpans = h.spanExporter.getFinishedSpans().filter(s => s.name === SPAN_SESSION);
    assert.equal(sessionSpans.length, 1);
  });

  test("completeLlm without a started llm span is a no-op", async () => {
    h.tracker.startSession();
    h.tracker.completeLlm(asstMsg({ text: "x" }) as never); // no active llm
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.spanExporter.getFinishedSpans().some(s => s.name === SPAN_LLM_REQUEST), false);
  });

  test("metrics failures never throw (best-effort)", async () => {
    const bad = makeHarness();
    // Replace metrics with one that throws on add/record.
    (bad as unknown as { metrics: { toolCalls: { add: () => never } } }).metrics = {
      toolCalls: { add: () => { throw new Error("metric boom"); } },
    } as never;
    bad.tracker.startSession();
    bad.tracker.startInteraction("p");
    bad.tracker.startTurn(0);
    bad.tracker.startTool("t1", "bash", {});
    assert.doesNotThrow(() => bad.tracker.endTool("t1", false, {}));
    bad.tracker.endTurn(); bad.tracker.endInteraction(); bad.tracker.endSession();
    await bad.flush();
    // The span still ends despite the metric throw.
    assert.ok(bad.spansByName()["pi.tool.bash"]);
  });
});

describe("orphan sweep", () => {
  // The sweep is belt-and-suspenders over the defensive closes in endInteraction.
  // It ends any span open longer than orphanTtlMs, marked pi.orphaned. We drive
  // it with a controllable fake clock and a manual timer so the test is instant
  // and deterministic.
  function makeSweepHarness(ttlMs: number) {
    let now = 1_000_000;
    let tick: () => void = () => {};
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "pi-test" }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("pi-otel-test", "0.0.0");
    const rec = new RecordingMetrics();
    const tracker = new SpanTracker({
      tracer,
      captureContent: "full",
      sessionId: () => "sweep-test",
      sessionFile: () => "/tmp/sweep.jsonl",
      cwd: "/test",
      metrics: () => recordingMetricsOf(rec),
      orphanTtlMs: ttlMs,
      orphanSweepIntervalMs: ttlMs,
      now: () => now,
      setTimer: (fn) => {
        tick = fn;
        return () => {};
      },
    });
    return {
      tracker,
      exporter,
      tick: () => tick(),
      advance(ms: number) {
        now += ms;
      },
      async flush() {
        await provider.forceFlush();
      },
    };
  }

  test("ends a tool span left open past the TTL, marked orphaned", async () => {
    const ttl = 5_000;
    const { tracker, exporter, tick, advance, flush } = makeSweepHarness(ttl);
    tracker.startSession();
    tracker.startInteraction("p");
    tracker.startTurn(0);
    tracker.startTool("t1", "bash", { command: "x" });
    advance(ttl + 1);
    tick();
    tracker.endSession();
    await flush();
    const tool = exporter.getFinishedSpans().find(s => s.name === "pi.tool.bash");
    assert.ok(tool, "tool span ended by the sweep");
    assert.equal(tool!.attributes[ATTR_PI_ORPHANED], true);
  });

  test("does not end a span younger than the TTL", async () => {
    const ttl = 5_000;
    const { tracker, exporter, tick, advance, flush } = makeSweepHarness(ttl);
    tracker.startSession();
    tracker.startInteraction("p");
    tracker.startTurn(0);
    tracker.startTool("t1", "bash", { command: "x" });
    advance(1_000);
    tick();
    tracker.endSession();
    await flush();
    const tool = exporter.getFinishedSpans().find(s => s.name === "pi.tool.bash");
    assert.ok(tool, "tool span present (ended by endSession, not by sweep)");
    assert.notEqual(tool!.attributes[ATTR_PI_ORPHANED], true, "not orphaned: closed before TTL");
  });
});
