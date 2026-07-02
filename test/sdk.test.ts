import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { trace, metrics, diag } from "@opentelemetry/api";
import { logs as logsApi } from "@opentelemetry/api-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { shutdownProviders, startRuntime, type ExportHealth } from "../src/sdk.ts";
import { resolveConfig } from "../src/config.ts";

/**
 * SDK lifecycle tests: startRuntime/shutdown behavior, idempotency, and the
 * critical "no global provider registration" property that lets pi-otel
 * survive /reload and session replacement.
 */

let savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL",
  "PI_OTEL_ENABLED", "PI_OTEL_TRACES", "PI_OTEL_METRICS", "PI_OTEL_LOGS",
  "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
] as const;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// Use a configurable endpoint so exporters don't actually try a real host.
function cfg(overrides: Record<string, unknown> = {}) {
  return { ...resolveConfig("/test"), endpoint: "http://127.0.0.1:9", ...overrides } as ReturnType<typeof resolveConfig>;
}

describe("startRuntime", () => {
  test("returns a runtime with all three providers when enabled", async () => {
    const rt = await startRuntime(cfg());
    try {
      assert.ok(rt.traceProvider, "trace provider present");
      assert.ok(rt.meterProvider, "meter provider present");
      assert.ok(rt.loggerProvider, "logger provider present");
      assert.ok(rt.tracer, "tracer present");
      assert.ok(typeof rt.flush === "function");
      assert.ok(typeof rt.shutdown === "function");
    } finally {
      await rt.shutdown();
    }
  });

  test("omits trace provider when traces disabled", async () => {
    const rt = await startRuntime(cfg({ traces: { enabled: false } }));
    try {
      assert.equal(rt.traceProvider, undefined);
      assert.ok(rt.meterProvider, "metrics still on");
      assert.ok(rt.loggerProvider, "logs still on");
    } finally {
      await rt.shutdown();
    }
  });

  test("omits all providers when master-enabled is false", async () => {
    const rt = await startRuntime(cfg({ enabled: false }));
    try {
      assert.equal(rt.traceProvider, undefined);
      assert.equal(rt.meterProvider, undefined);
      assert.equal(rt.loggerProvider, undefined);
      // tracer still returned (no-op) so callers don't have to branch
      assert.ok(rt.tracer);
    } finally {
      await rt.shutdown();
    }
  });
});

describe("shutdown", () => {
  test("is idempotent (second call does not throw)", async () => {
    const rt = await startRuntime(cfg());
    await rt.shutdown();
    await assert.doesNotReject(() => rt.shutdown());
  });

  test("flush completes without error even with no collector", async () => {
    const rt = await startRuntime(cfg());
    try {
      // flush against a dead endpoint; must not reject
      await assert.doesNotReject(() => rt.flush());
    } finally {
      await rt.shutdown();
    }
  });

  test("shutdown completes even against a dead endpoint (best-effort)", async () => {
    const rt = await startRuntime(cfg());
    await assert.doesNotReject(() => rt.shutdown());
  });

  test("shutdown returns within shutdownTimeoutMs against a hanging collector", async () => {
    // Simulate a dead collector with an in-process exporter whose export()
    // never invokes its callback. This is exactly what a TCP listener that
    // accepts but never responds looks like from the SDK's side: the
    // BatchSpanProcessor's forceFlush/shutdown awaits the export result
    // forever. We avoid a real socket here because the OTLP HTTP exporter's
    // keep-alive agent holds the client-side socket in its pool after the
    // timeout fires, keeping the test process alive on teardown.
    const hangingExporter: SpanExporter = {
      export(_spans: ReadableSpan[], _cb: (r: { code: number }) => void): void {
        // deliberately never call the callback: simulates a hung collector.
      },
      async shutdown(): Promise<void> {
        // The exporter itself shuts down fine; the hang is in export() above.
        // (BatchSpanProcessor.forceFlush is what blocks on the never-called cb.)
      },
    };
    const traceProvider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "pi-test" }),
      spanProcessors: [
        // exportTimeoutMillis bounds the BatchSpanProcessor's own internal
        // export-wait timer (which is a referenced timer in the SDK). We set it
        // just above shutdownTimeoutMs so our shutdown race is what fires first
        // (proving the timeout path), while the processor's timer still settles
        // shortly after so the test process exits without hanging on it.
        new BatchSpanProcessor(hangingExporter, { exportTimeoutMillis: 600 }),
      ],
    });
    // End a span so the batch processor has pending work to flush on shutdown;
    // otherwise forceFlush/shutdown complete instantly with nothing to export.
    const span = traceProvider.getTracer("pi-otel-test", "0.0.0").startSpan("hang.test");
    span.end();

    const health: ExportHealth = { spansExported: 0, metricBatchesExported: 0, logRecordsExported: 0 };
    const timeoutMs = 400;
    const start = Date.now();
    await shutdownProviders(traceProvider, undefined, undefined, timeoutMs, health);
    const elapsed = Date.now() - start;
    // Returns within the budget (not the full 2000ms default) and the timeout
    // fired at roughly shutdownTimeoutMs.
    assert.ok(elapsed < 2000, `shutdown should respect the timeout, took ${elapsed}ms`);
    assert.ok(elapsed >= timeoutMs, `shutdown should have waited for the timeout, took ${elapsed}ms`);
    assert.ok(health.lastShutdownError, "lastShutdownError should be set when the timeout fires");
    assert.match(health.lastShutdownError!, /timeout/i);
  });
});

describe("no global registration (survives /reload)", () => {
  test("does not register a global tracer provider", async () => {
    // Capture the global tracer provider reference before start; it must be
    // the same (no-op) provider after start as before.
    const before = trace.getTracerProvider();
    const rt = await startRuntime(cfg());
    try {
      assert.equal(trace.getTracerProvider(), before, "global tracer provider unchanged");
    } finally {
      await rt.shutdown();
    }
    assert.equal(trace.getTracerProvider(), before, "still unchanged after shutdown");
  });

  test("does not register a global meter provider", async () => {
    const before = metrics.getMeterProvider();
    const rt = await startRuntime(cfg());
    try {
      assert.equal(metrics.getMeterProvider(), before);
    } finally {
      await rt.shutdown();
    }
  });

  test("does not register a global logger provider", async () => {
    const before = logsApi.getLoggerProvider();
    const rt = await startRuntime(cfg());
    try {
      assert.equal(logsApi.getLoggerProvider(), before);
    } finally {
      await rt.shutdown();
    }
  });

  test("two sequential runtimes do not interfere (reload simulation)", async () => {
    const before = trace.getTracerProvider();
    const rt1 = await startRuntime(cfg());
    await rt1.shutdown();
    const rt2 = await startRuntime(cfg());
    try {
      assert.equal(trace.getTracerProvider(), before, "global still not set after rt1+rt2");
      assert.ok(rt2.traceProvider, "rt2 has its own provider");
    } finally {
      await rt2.shutdown();
    }
  });
});

describe("resource", () => {
  test("resource carries service.name and pi.cwd", async () => {
    const rt = await startRuntime(cfg());
    try {
      const resource = rt.traceProvider!["resource"] ?? (rt.traceProvider as unknown as { _resource: { attributes: Record<string, unknown> } })._resource;
      const attrs = resource.attributes;
      assert.equal(attrs["service.name"], "pi");
      assert.equal(attrs["pi.cwd"], "/test");
    } finally {
      await rt.shutdown();
    }
  });
});

describe("per-signal exporters", () => {
  test("multi-exporter traces: otlp+console yields two span processors", async () => {
    const origWrite = process.stdout.write.bind(process.stdout);
    const out: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const rt = await startRuntime(cfg({ tracesExporters: ["otlp", "console"] }));
    try {
      assert.ok(rt.traceProvider, "trace provider present");
      const span = rt.tracer.startSpan("console-export-test");
      span.end();
      await rt.flush();
      const joined = out.join("");
      assert.match(joined, /console-export-test/);
    } finally {
      process.stdout.write = origWrite;
      await rt.shutdown();
    }
  });

  test("metrics console exporter does not throw", async () => {
    const rt = await startRuntime(cfg({ metricsExporters: ["console"] }));
    try {
      const meter = rt.meterProvider!.getMeter("pi-otel-test");
      const counter = meter.createCounter("test.counter");
      counter.add(1);
      await assert.doesNotReject(() => rt.meterProvider!.forceFlush());
    } finally {
      await rt.shutdown();
    }
  });

  test("none alone disables traces", async () => {
    const rt = await startRuntime(cfg({ tracesExporters: ["none"] }));
    try {
      assert.equal(rt.traceProvider, undefined);
      const span = rt.tracer.startSpan("noop-span");
      assert.ok(span);
      span.end();
    } finally {
      await rt.shutdown();
    }
  });

  test("console stripped in TUI mode, falls back to otlp", async () => {
    const rt = await startRuntime(cfg({ tracesExporters: ["console"] }), { hasUI: true });
    try {
      assert.ok(rt.traceProvider, "fell back to otlp trace provider");
      const span = rt.tracer.startSpan("tui-fallback");
      assert.ok(span);
      span.end();
    } finally {
      await rt.shutdown();
    }
  });

  test("delta temporality env defaulted when unset", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE;
    const rt = await startRuntime(cfg());
    try {
      assert.equal(process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, "DELTA");
    } finally {
      await rt.shutdown();
    }
  });

  test("delta temporality env not overwritten when preset", async () => {
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = "CUMULATIVE";
    const rt = await startRuntime(cfg());
    try {
      assert.equal(process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, "CUMULATIVE");
    } finally {
      await rt.shutdown();
    }
  });
});

// Re-exports used only for the type narrowing above.
void diag; void InMemorySpanExporter; void InMemoryLogRecordExporter;
