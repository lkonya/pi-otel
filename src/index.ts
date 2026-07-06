/**
 * pi-otel — OpenTelemetry traces, metrics, and logs for the pi coding agent.
 *
 * A pure, standards-compliant OTLP exporter. Emits strict OTel semantic
 * conventions (gen_ai.*, service.*, process.*, host.*) so a downstream
 * collector or hosted platform can translate as needed.
 *
 * Span tree:
 *   pi.session                      (root, per session)
 *   └─ pi.interaction               (per user prompt)
 *      └─ pi.turn                   (per LLM call + tools)
 *         ├─ pi.llm_request [CLIENT]
 *         └─ pi.tool.<name>
 *
 * All telemetry is on by default. Config in `.pi/settings.json` -> `otel`
 * or via standard OTEL_* / PI_OTEL_* env vars. See README for the full schema.
 *
 * Other pi extensions can route structured logs through this exporter:
 *   pi.events.emit("pi-otel:log", {
 *     eventName: "my.event", severity: "info",
 *     body: "...", attributes: { k: "v" },
 *   });
 */

import { basename } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MessageShapes } from "./tracker.js";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resolveConfig } from "./config.js";
import { registerCommands } from "./commands.js";
import { emitLog } from "./logging.js";
import { getMetrics, resetMetrics } from "./metrics.js";
import { resetLogger } from "./logging.js";
import { type TelemetryRuntime, startRuntime } from "./sdk.js";
import { clampAttr } from "./attrs.js";
import { configureCapture, extractMessageText, SpanTracker, type SessionReason } from "./tracker.js";

/** Normalized shape of a pi-otel:log payload from another extension. */
interface LogChannelPayload {
  eventName: string;
  severity: string;
  body: string;
  attributes: Record<string, string | number | boolean>;
}

const ALLOWED_SEVERITIES = new Set(["trace", "debug", "info", "warn", "warning", "error", "fatal"]);

/**
 * Validate and normalize a pi-otel:log payload from an untrusted extension.
 * Returns null when the payload is not usable. Primitive attribute values are
 * kept; nested objects and arrays are dropped (the OTLP log model only
 * accepts scalar attribute values). Strings are clamped to the attribute
 * ceiling so a misbehaving extension cannot push oversized records.
 */
export function normalizeLogPayload(data: unknown): LogChannelPayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const eventName = typeof d.eventName === "string" ? d.eventName : null;
  if (!eventName) return null;
  const severity =
    typeof d.severity === "string" && ALLOWED_SEVERITIES.has(d.severity.toLowerCase())
      ? d.severity.toLowerCase()
      : "info";
  const body = typeof d.body === "string" ? clampAttr(d.body) : "";
  const rawAttrs = (d.attributes ?? null) as unknown;
  const attributes: Record<string, string | number | boolean> = {};
  if (rawAttrs && typeof rawAttrs === "object" && !Array.isArray(rawAttrs)) {
    for (const [k, v] of Object.entries(rawAttrs as Record<string, unknown>)) {
      if (typeof v === "string") attributes[k] = clampAttr(v);
      else if (typeof v === "number" || typeof v === "boolean") attributes[k] = v;
      // objects, arrays, null, undefined, etc. are dropped
    }
  }
  return { eventName, severity, body, attributes };
}

export default function (pi: ExtensionAPI): void {
  // Commands are registered up front so /otel-status works even before
  // a session starts (e.g. to debug why nothing is exporting).
  let runtime: TelemetryRuntime | null = null;
  let tracker: SpanTracker | null = null;
  let cfg = resolveConfig(process.cwd());
  // captureContent is process-wide in the tracker module; mirror it.
  configureCapture(cfg.captureContent);

  registerCommands(pi, () => runtime);

  // pi-otel:log — cross-extension log channel. Best-effort; no-op when logs
  // are disabled or the runtime isn't up yet. Payloads are untrusted and get
  // validated before they reach the OTLP logger.
  pi.events.on("pi-otel:log", (data: unknown) => {
    const payload = normalizeLogPayload(data);
    if (!payload) return;
    emitLog(
      runtime?.loggerProvider,
      payload.eventName,
      payload.severity,
      payload.body,
      payload.attributes,
    );
  });

  // Keep ctx around for handlers that don't receive it.
  let lastCtx: ExtensionContext | undefined;

  const sessionFile = () => {
    try {
      const f = lastCtx?.sessionManager?.getSessionFile?.();
      return f ?? undefined;
    } catch {
      return undefined;
    }
  };
  const sessionId = () => {
    const f = sessionFile();
    return f ? basename(f, ".jsonl") : undefined;
  };

  const start = async (ctx: ExtensionContext, reason?: SessionReason, parentId?: string): Promise<void> => {
    if (runtime) return; // idempotent
    // Re-resolve config with the session's cwd so project settings win.
    cfg = resolveConfig(ctx.cwd);
    configureCapture(cfg.captureContent);
    if (!cfg.enabled) return;
    runtime = await startRuntime(cfg, { hasUI: ctx.hasUI });
    resetMetrics();
    resetLogger();
    tracker = new SpanTracker({
      tracer: runtime.tracer,
      captureContent: cfg.captureContent,
      sessionId,
      sessionFile,
      cwd: ctx.cwd,
      metrics: () => getMetrics(runtime?.meterProvider),
    });
    tracker.startSession(reason, parentId);
  };

  const stop = async (reason: string): Promise<void> => {
    try {
      tracker?.endSession();
    } catch { /* best-effort */ }
    tracker = null;
    if (runtime) {
      // Detach this runtime's signal handlers whether we shut down or only
      // flush. Reload rebuilds the runtime on the next session_start and
      // registers a fresh pair; leaving the old pair attached would stack a
      // new set of SIGTERM/SIGHUP listeners on process every reload.
      runtime.removeProcessHooks();
      // reload should flush (keep SDK for the next factory's spans); quit shuts down.
      if (reason === "quit") {
        await runtime.shutdown();
      } else {
        await runtime.flush();
      }
    }
    // For non-quit reasons the runtime is rebuilt on next session_start.
    // Drop the reference either way; start() will rebuild it.
    runtime = null;
    void reason;
  };

  // ----------------------------------------------------------------- events
  pi.on("session_start", async (event, ctx) => {
    lastCtx = ctx;
    const parentId = event.previousSessionFile
      ? basename(event.previousSessionFile, ".jsonl")
      : undefined;
    await start(ctx, event.reason, parentId);
    if (cfg.selfLogs && runtime) {
      emitLog(
        runtime.loggerProvider,
        "pi.session.start",
        SeverityNumber.INFO,
        `pi session ${sessionId() ?? "(ephemeral)"} started`,
        { "pi.cwd": ctx.cwd },
      );
    }
  });

  pi.on("session_shutdown", async (event, _ctx) => {
    await stop(event.reason);
  });

  // Defensive cleanup on every session-replacement flow so no spans orphan.
  pi.on("session_before_switch", async () => {
    tracker?.endInteraction({ reason: "session_switch" });
  });
  pi.on("session_before_fork", async () => {
    tracker?.endInteraction({ reason: "session_fork" });
  });
  pi.on("session_before_compact", async () => {
    // Don't end the interaction — compaction happens mid-interaction.
    // We just record it as an event/metric when it completes.
  });
  pi.on("session_before_tree", async () => {
    tracker?.endInteraction({ reason: "session_tree" });
  });

  pi.on("session_compact", async (event, _ctx) => {
    const attrs: Record<string, string | number | boolean> = {
      "pi.compaction.from_extension": Boolean(event.fromExtension),
      "pi.compaction.reason": event.reason,
    };
    if (typeof event.compactionEntry?.tokensBefore === "number") {
      attrs["pi.compaction.tokens_before"] = event.compactionEntry.tokensBefore;
    }
    runtime && cfg.selfLogs && emitLog(
      runtime.loggerProvider,
      "pi.session.compact",
      SeverityNumber.INFO,
      `session compacted (${event.reason})`,
      attrs,
    );
    try {
      getMetrics(runtime?.meterProvider)?.compactionCount.add(1, attrs as Record<string, string>);
    } catch { /* noop */ }
  });

  // ----------------------------------------------------------- agent flow
  pi.on("before_agent_start", async (event, ctx) => {
    lastCtx = ctx;
    tracker?.startInteraction(event.prompt);
    tracker?.noteSystemPrompt(event.systemPrompt);
  });

  pi.on("turn_start", async (event, ctx) => {
    lastCtx = ctx;
    tracker?.startTurn(event.turnIndex);
    // Wire abort -> cancellation marking on the active turn.
    const signal = ctx.signal;
    if (signal && !signal.aborted) {
      signal.addEventListener(
        "abort",
        () => {
          // Only count aborts that actually cancelled an in-flight turn, so
          // mashing Esc outside a turn does not inflate the counter.
          const cancelled = tracker?.markCancelled() ?? false;
          if (cancelled) {
            try { getMetrics(runtime?.meterProvider)?.turnCancellations.add(1); } catch { /* noop */ }
          }
        },
        { once: true },
      );
    }
  });

  pi.on("turn_end", async (event, _ctx) => {
    const msg = event.message;
    if (msg && msg.role === "assistant") {
      // The LLM span is opened in before_provider_request and finalized here
      // once usage/finish are known.
      tracker?.completeLlm(msg as MessageShapes.AssistantMessage);
    }
    tracker?.endTurn({ reason: "end" });
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    const model = ctx.model;
    tracker?.startLlm(model?.id, model?.provider);
  });

  pi.on("after_provider_response", async (event, _ctx) => {
    tracker?.recordProviderResponse(event.status, event.headers ?? {});
  });

  pi.on("message_update", async (event, _ctx) => {
    tracker?.noteFirstToken(event.message);
  });

  pi.on("message_end", async (event, _ctx) => {
    tracker?.noteLlmComplete(event.message);
  });

  // Capture input messages for the gen_ai.input.messages attribute.
  pi.on("message_start", async (event, _ctx) => {
    const msg = event.message;
    if (!msg) return;
    if (msg.role === "user") {
      tracker?.noteUserInput(extractMessageText(msg));
    } else if (msg.role === "toolResult") {
      const tr = msg as { toolCallId: string; toolName: string };
      tracker?.noteToolResultInput(tr.toolCallId, tr.toolName, extractMessageText(msg));
    }
  });

  pi.on("agent_end", async (_event, _ctx) => {
    tracker?.endInteraction({ reason: "end" });
  });

  // ----------------------------------------------------------- tool events
  pi.on("tool_execution_start", async (event, _ctx) => {
    tracker?.startTool(event.toolCallId, event.toolName, event.args);
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    tracker?.endTool(event.toolCallId, event.isError, event.result);
  });

  // ----------------------------------------------------------- model changes
  pi.on("model_select", async (event, _ctx) => {
    const attrs: Record<string, string> = {
      "pi.model.source": event.source,
    };
    if (event.previousModel) {
      attrs["pi.model.previous"] = `${event.previousModel.provider}/${event.previousModel.id}`;
    }
    attrs["pi.model.current"] = `${event.model.provider}/${event.model.id}`;
    runtime && cfg.selfLogs && emitLog(
      runtime.loggerProvider,
      "pi.model.changed",
      SeverityNumber.INFO,
      `model changed: ${attrs["pi.model.current"]}`,
      attrs,
    );
  });

  // ------------------------------------------------------------- user bash
  pi.on("user_bash", async (event, _ctx) => {
    runtime && cfg.selfLogs && emitLog(
      runtime.loggerProvider,
      "pi.user_bash",
      SeverityNumber.INFO,
      `user bash: ${event.command.slice(0, 120)}`,
      { "pi.user_bash.cwd": event.cwd, "pi.user_bash.exclude_from_context": event.excludeFromContext },
    );
  });

  pi.on("input", async (event, _ctx) => {
    if (event.source !== "interactive") return;
    runtime && cfg.selfLogs && emitLog(
      runtime.loggerProvider,
      "pi.input",
      SeverityNumber.INFO,
      `user input (${event.source})`,
      { "pi.input.image_count": event.images?.length ?? 0 },
    );
  });
}
