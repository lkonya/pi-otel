/**
 * Slash commands: /otel-status, /otel-flush, /otel-test.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelemetryRuntime } from "./sdk.js";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { emitLog } from "./logging.js";

// (ATTR_TEST_FLAG removed — use the literal "pi.test" inline.)

export function registerCommands(pi: ExtensionAPI, getRuntime: () => TelemetryRuntime | null): void {
  pi.registerCommand("otel-status", {
    description: "Show pi-otel configuration and export health",
    handler: async (_args, ctx: ExtensionContext) => {
      const rt = getRuntime();
      if (!rt) {
        const msg = "pi-otel: disabled (no telemetry runtime)";
        ctx.hasUI ? ctx.ui.notify(msg, "warning") : console.log(msg);
        return;
      }
      const c = rt.config;
      const h = rt.health;
      const lines = [
        `enabled            ${c.enabled}`,
        `endpoint           ${c.endpoint}`,
        `traces             ${c.traces.enabled ? c.tracesEndpoint : "(off)"}${h.tracesError ? `  ERROR: ${h.tracesError}` : ""}`,
        `traces exporters   ${c.tracesExporters.join(",")}`,
        `metrics            ${c.metrics.enabled ? c.metricsEndpoint : "(off)"}${h.metricsError ? `  ERROR: ${h.metricsError}` : ""}`,
        `metrics exporters  ${c.metricsExporters.join(",")}`,
        `logs               ${c.logs.enabled ? c.logsEndpoint : "(off)"}${h.logsError ? `  ERROR: ${h.logsError}` : ""}`,
        `logs exporters     ${c.logsExporters.join(",")}`,
        `protocol           ${c.protocol}`,
        `service.name       ${c.serviceName}`,
        `captureContent     ${c.captureContent}`,
        `sampleRatio        ${c.sampleRatio}`,
        `shutdown timeout   ${c.shutdownTimeoutMs}`,
        `exported spans     ${h.spansExported}`,
        `metric batches     ${h.metricBatchesExported}`,
        `log records        ${h.logRecordsExported}`,
        `last shutdown err  ${h.lastShutdownError ?? "(none)"}`,
      ];
      const text = lines.join("\n");
      ctx.hasUI ? ctx.ui.notify(text, "info") : console.log(text);
    },
  });

  pi.registerCommand("otel-flush", {
    description: "Force-flush pending OTel telemetry",
    handler: async (_args, ctx: ExtensionContext) => {
      const rt = getRuntime();
      if (!rt) {
        ctx.ui.notify("pi-otel: disabled", "warning");
        return;
      }
      await rt.flush();
      ctx.ui.notify("pi-otel: flushed", "info");
    },
  });

  pi.registerCommand("otel-test", {
    description: "Emit a synthetic span, metric, and log to verify the pipeline",
    handler: async (_args, ctx: ExtensionContext) => {
      const rt = getRuntime();
      if (!rt) {
        ctx.ui.notify("pi-otel: disabled", "warning");
        return;
      }
      const c = rt.config;
      // --- Trace ---
      if (c.traces.enabled) {
        const span = rt.tracer.startSpan("pi.otel.self_test", {
          attributes: { "pi.test": true },
        });
        span.addEvent("pi.otel.self_test.event", { note: "synthetic" });
        span.end();
      }
      // --- Metric ---
      if (c.metrics.enabled) {
        // Use the meter via the runtime's provider so it lands in the right exporter.
        const meter = rt.meterProvider?.getMeter("pi-otel", "0.1.0");
        const counter = meter?.createCounter("pi.otel.self_test", {
          description: "pi-otel self-test counter",
          unit: "{event}",
        });
        counter?.add(1, { source: "otel-test" });
      }
      // --- Log ---
      if (c.logs.enabled && c.selfLogs) {
        emitLog(rt.loggerProvider, "pi.otel.self_test", SeverityNumber.INFO, "pi-otel self-test log record", {
          "pi.test": true,
        });
      }
      await rt.flush();
      const ok = c.traces.enabled || c.metrics.enabled || c.logs.enabled;
      ctx.ui.notify(
        ok
          ? `pi-otel: emitted self-test (traces=${c.traces.enabled}, metrics=${c.metrics.enabled}, logs=${c.logs.enabled}). Check your backend.`
          : "pi-otel: all signals disabled",
        ok ? "info" : "warning",
      );
    },
  });
}

