/**
 * OTel SDK bootstrap and teardown.
 *
 * One TelemetryRuntime per session. All SDK objects (providers, processors,
 * readers, exporters) are created here in `startRuntime` and torn down in
 * the runtime's `shutdown`. We deliberately never register globals
 * (`trace.setGlobalTracerProvider`, etc.) so that pi's `/reload` and session
 * replacement flows don't leak zombie providers that keep exporting after the
 * session that created them is gone.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname, userInfo, version as nodeVersion } from "node:os";
import { extensionVersion } from "./version.js";
import {
  diag,
  type DiagLogger,
  type Tracer,
} from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter as LogProtoExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { AggregationTemporalityPreference } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as MetricProtoExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as TraceProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  detectResources,
  hostDetector,
  osDetector,
  processDetector,
  resourceFromAttributes,
  serviceInstanceIdDetector,
  type Resource,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { ExporterToken, Protocol, ResolvedConfig } from "./config.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { createLogger } from "./logging.js";
import type { Logger } from "@opentelemetry/api-logs";

const TRACER_NAME = "pi-otel";
const TRACER_VERSION = extensionVersion();

/** Last error observed from any exporter, plus the last shutdown failure.
 * Surfaced via /otel-status. */
export interface ExportHealth {
  tracesError?: string;
  metricsError?: string;
  logsError?: string;
  lastShutdownError?: string;
  /** Total spans accepted by a successful export (sum of batch sizes). */
  spansExported: number;
  /** Successful metric export calls (one ResourceMetrics payload each). */
  metricBatchesExported: number;
  /** Total log records accepted by a successful export (sum of batch sizes). */
  logRecordsExported: number;
}

export interface RuntimeOptions {
  /** When true, the process is running inside pi's TUI. Console exporters
   *  would spam the UI, so the console token is stripped from every signal. */
  hasUI?: boolean;
}

export interface TelemetryRuntime {
  config: ResolvedConfig;
  tracer: Tracer;
  /** Metric instruments bound to this runtime's meter provider (null if metrics off). */
  metrics: Metrics | null;
  /** Logger bound to this runtime's logger provider (null if logs off). */
  logger: Logger | null;
  loggerProvider?: LoggerProvider;
  meterProvider?: MeterProvider;
  traceProvider?: BasicTracerProvider;
  health: ExportHealth;
  /** Force-flush all active providers. Best-effort; never throws. */
  flush: () => Promise<void>;
  /** Shut down all active providers and release resources. Idempotent. */
  shutdown: () => Promise<void>;
  /** Detach the SIGTERM/SIGHUP handlers registered for this runtime. */
  removeProcessHooks: () => void;
}

export interface ExporterOpts {
  url: string;
  headers: Record<string, string>;
}

/**
 * Resolve metric aggregation temporality without mutating process.env.
 * Honors OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE when set; defaults
 * to DELTA for short-lived agent processes (cumulative counters reset per run).
 */
export function resolveMetricTemporalityPreference(
  env: NodeJS.ProcessEnv = process.env,
): AggregationTemporalityPreference {
  const raw = env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE?.trim().toLowerCase();
  if (raw === "cumulative") return AggregationTemporalityPreference.CUMULATIVE;
  if (raw === "lowmemory") return AggregationTemporalityPreference.LOWMEMORY;
  // unset, "delta", or unknown -> DELTA (agent-friendly default)
  return AggregationTemporalityPreference.DELTA;
}

async function newTraceExporter(p: Protocol, o: ExporterOpts): Promise<SpanExporter> {
  if (p === "grpc") {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
    return new OTLPTraceExporter(o);
  }
  if (p === "http/json") {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    return new OTLPTraceExporter(o);
  }
  return new TraceProtoExporter(o);
}
async function newMetricExporter(p: Protocol, o: ExporterOpts): Promise<PushMetricExporter> {
  const opts = { ...o, temporalityPreference: resolveMetricTemporalityPreference() };
  if (p === "grpc") {
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc");
    return new OTLPMetricExporter(opts);
  }
  if (p === "http/json") {
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
    return new OTLPMetricExporter(opts);
  }
  return new MetricProtoExporter(opts);
}
async function newLogExporter(p: Protocol, o: ExporterOpts): Promise<LogRecordExporter> {
  if (p === "grpc") {
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-grpc");
    return new OTLPLogExporter(o);
  }
  if (p === "http/json") {
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
    return new OTLPLogExporter(o);
  }
  return new LogProtoExporter(o);
}

/** Generic export-result shape used by all three exporter families. */
interface ExportResult {
  code: number;
  error?: Error;
}
type ExportFn = (items: unknown, cb: (r: ExportResult) => void) => void;

/** Count items in a trace/log export payload. Metric payloads are not arrays. */
function exportItemCount(items: unknown): number {
  return Array.isArray(items) ? items.length : 0;
}

/**
 * Wrap an exporter's export() so the last failure is captured for /otel-status
 * without propagating the error (exporters already retry internally).
 * onResult receives the number of items in the batch on success (0 for metrics).
 */
function trackHealth<T>(
  exporter: T,
  onResult: (ok: boolean, itemCount: number, errMsg?: string) => void,
): T {
  const orig = (exporter as unknown as { export: ExportFn }).export.bind(exporter) as ExportFn;
  (exporter as unknown as { export: ExportFn }).export = ((items: unknown, cb: (r: ExportResult) => void) => {
    const count = exportItemCount(items);
    orig(items, (result) => {
      if (result.code === 0) onResult(true, count);
      else onResult(false, count, result.error?.message ?? "export failed");
      cb(result);
    });
  }) as ExportFn;
  return exporter;
}

/**
 * Detect a stable host.id. Falls back to hostname when no platform id exists.
 */
export function detectHostId(): string {
  if (process.platform === "linux") {
    for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = readFileSync(candidate, "utf8").trim();
        if (id) return id;
      } catch {
        // missing or unreadable — try the next candidate
      }
    }
  }
  return hostname();
}

let cachedPiVersion: string | undefined;
function piVersion(): string {
  if (cachedPiVersion !== undefined) return cachedPiVersion;
  try {
    const url = import.meta.resolve?.("@earendil-works/pi-coding-agent/package.json");
    if (url) {
      const pkg = JSON.parse(readFileSync(new URL(url), "utf8"));
      cachedPiVersion = (pkg.version as string | undefined) ?? "unknown";
      return cachedPiVersion;
    }
  } catch {
    // ignore
  }
  cachedPiVersion = "unknown";
  return cachedPiVersion;
}

export async function buildResource(cfg: ResolvedConfig): Promise<Resource> {
  // Auto-detect host/process/os/service-instance via SDK detectors.
  const detected = await detectResources({
    detectors: [hostDetector, processDetector, osDetector, serviceInstanceIdDetector],
  });

  const piAttrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_SERVICE_VERSION]: piVersion(),
    [ATTR_SERVICE_INSTANCE_ID]: `${process.pid}-${randomBytes(4).toString("hex")}`,
    "host.name": hostname(),
    "host.id": detectHostId(),
    "process.runtime.name": "node",
    "process.runtime.version": nodeVersion(),
    "process.owner": userInfo().username ?? "unknown",
    "pi.cwd": cfg.cwd,
    "pi.extension.name": TRACER_NAME,
    "pi.extension.version": TRACER_VERSION,
  };

  // Merge: detected (lowest) < pi attrs < user OTEL_RESOURCE_ATTRIBUTES (highest).
  return detected
    .merge(resourceFromAttributes(piAttrs))
    .merge(resourceFromAttributes(cfg.resourceAttributes));
}

/**
 * Resolve the exporter token list for one signal. In TUI mode, strip console
 * exporters: span/log JSON on stdout corrupts the terminal UI. If stripping
 * leaves nothing (e.g. only console was configured), fall back to otlp so
 * telemetry is not silently dropped.
 */
function effectiveExporterTokens(tokens: ExporterToken[], hasUI: boolean): ExporterToken[] {
  let effective = hasUI ? tokens.filter((t) => t !== "console") : [...tokens];
  if (effective.length === 0) effective = ["otlp"];
  return effective;
}

/** True when the signal should get a provider (not disabled and not only "none"). */
function signalExportersActive(tokens: ExporterToken[]): boolean {
  return tokens.length > 0 && !(tokens.length === 1 && tokens[0] === "none");
}

export async function startRuntime(
  cfg: ResolvedConfig,
  opts: RuntimeOptions = {},
): Promise<TelemetryRuntime> {
  const hasUI = opts.hasUI ?? false;
  const health: ExportHealth = {
    spansExported: 0,
    metricBatchesExported: 0,
    logRecordsExported: 0,
  };

  // diag is the only global we touch. Default NONE.
  diag.setLogger(noopDiagLogger(), {
    logLevel: cfg.diagLogLevel,
    suppressOverrideMessage: true,
  });

  const resource = await buildResource(cfg);

  // --- Traces ---
  let traceProvider: BasicTracerProvider | undefined;
  if (cfg.enabled && cfg.traces.enabled) {
    const traceTokens = effectiveExporterTokens(cfg.tracesExporters, hasUI);
    if (signalExportersActive(traceTokens)) {
      const spanProcessors = [];
      for (const token of traceTokens) {
        if (token === "none") continue;
        if (token === "otlp") {
          const exporter = trackHealth(
            await newTraceExporter(cfg.protocol, { url: cfg.tracesEndpoint, headers: cfg.headers }),
            (ok, count, err) => {
              if (ok) { health.spansExported += count; health.tracesError = undefined; }
              else { health.tracesError = err; }
            },
          );
          spanProcessors.push(
            new BatchSpanProcessor(exporter, { scheduledDelayMillis: cfg.tracesExportInterval }),
          );
        } else if (token === "console") {
          spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
        }
      }
      if (spanProcessors.length > 0) {
        const sampler = cfg.sampleRatio >= 1
          ? undefined
          : new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(cfg.sampleRatio) });
        traceProvider = new BasicTracerProvider({
          resource,
          ...(sampler ? { sampler } : {}),
          spanProcessors,
        });
      }
    }
  }

  // --- Metrics ---
  let meterProvider: MeterProvider | undefined;
  if (cfg.enabled && cfg.metrics.enabled) {
    const metricTokens = effectiveExporterTokens(cfg.metricsExporters, hasUI);
    if (signalExportersActive(metricTokens)) {
      const readers = [];
      for (const token of metricTokens) {
        if (token === "none") continue;
        if (token === "otlp") {
          const exporter = trackHealth(
            await newMetricExporter(cfg.protocol, { url: cfg.metricsEndpoint, headers: cfg.headers }),
            (ok, _count, err) => {
              if (ok) { health.metricBatchesExported++; health.metricsError = undefined; }
              else { health.metricsError = err; }
            },
          );
          readers.push(
            new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: cfg.metricExportInterval }),
          );
        } else if (token === "console") {
          readers.push(
            new PeriodicExportingMetricReader({
              exporter: new ConsoleMetricExporter(),
              exportIntervalMillis: cfg.metricExportInterval,
            }),
          );
        }
      }
      if (readers.length > 0) {
        meterProvider = new MeterProvider({ resource, readers });
      }
    }
  }

  // --- Logs ---
  let loggerProvider: LoggerProvider | undefined;
  if (cfg.enabled && cfg.logs.enabled) {
    const logTokens = effectiveExporterTokens(cfg.logsExporters, hasUI);
    if (signalExportersActive(logTokens)) {
      const processors = [];
      for (const token of logTokens) {
        if (token === "none") continue;
        if (token === "otlp") {
          const exporter = trackHealth(
            await newLogExporter(cfg.protocol, { url: cfg.logsEndpoint, headers: cfg.headers }),
            (ok, count, err) => {
              if (ok) { health.logRecordsExported += count; health.logsError = undefined; }
              else { health.logsError = err; }
            },
          );
          processors.push(
            new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: cfg.logsExportInterval }),
          );
        } else if (token === "console") {
          processors.push(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()));
        }
      }
      if (processors.length > 0) {
        loggerProvider = new LoggerProvider({ resource, processors });
      }
    }
  }

  const tracer = traceProvider?.getTracer(TRACER_NAME, TRACER_VERSION) ?? noopTracer();
  // Bind instruments/logger to this runtime so a reload cannot keep writing
  // into a provider that has already been shut down.
  const metrics = createMetrics(meterProvider);
  const logger = createLogger(loggerProvider);

  let shutdownStarted = false;

  // Crash insurance: pi fires session_shutdown on normal exit, but SIGTERM
  // (container stop, IDE shutdown) and SIGHUP (closed terminal) can skip it.
  // Register on those signals to flush+shutdown best-effort. We deliberately
  // do NOT register on 'exit' or 'beforeExit': 'beforeExit' re-arms the event
  // loop when its async work schedules, looping indefinitely; 'exit' runs
  // synchronously and cannot await the flush, so it just adds noise.
  // removeProcessHooks is exposed on the runtime so callers can detach the
  // previous session's handlers when the runtime is replaced (reload) without
  // a full shutdown; otherwise each reload stacks a fresh pair of listeners.
  const onSignal = () => { void shutdown(); };
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  const removeProcessHooks = (): void => {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
  };

  const flush = async (): Promise<void> => {
    if (shutdownStarted) return;
    await Promise.allSettled([
      traceProvider?.forceFlush(),
      meterProvider?.forceFlush(),
      loggerProvider?.forceFlush(),
    ]);
  };

  // Run forceFlush then shutdown for each provider in parallel, then race the
  // whole thing against a timeout. A slow or dead collector endpoint would
  // otherwise hang pi's exit. Each provider chains flush->shutdown so a slow
  // logger flush does not delay the meter or tracer shutdown.
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    removeProcessHooks();
    await shutdownProviders(traceProvider, meterProvider, loggerProvider, cfg.shutdownTimeoutMs, health);
  };

  return {
    config: cfg,
    tracer,
    metrics,
    logger,
    traceProvider,
    meterProvider,
    loggerProvider,
    health,
    flush,
    shutdown,
    removeProcessHooks,
  };
}

/** Minimal provider surface that shutdown needs: forceFlush + shutdown. */
interface ShutdownableProvider {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Run forceFlush then shutdown for each provider in parallel, racing the whole
 * thing against `timeoutMs`. On timeout, record the failure on `health` and
 * swallow it: a broken collector must never block pi's exit. Each provider
 * chains flush->shutdown so a slow logger flush does not delay the meter or
 * tracer shutdown. Extracted from `startRuntime` so the timeout behavior is
 * unit-testable without spinning up a real collector socket.
 */
export async function shutdownProviders(
  traceProvider: ShutdownableProvider | undefined,
  meterProvider: ShutdownableProvider | undefined,
  loggerProvider: ShutdownableProvider | undefined,
  timeoutMs: number,
  health: ExportHealth,
): Promise<void> {
  const chains: Promise<void>[] = [];
  if (traceProvider) chains.push(traceProvider.forceFlush().then(() => traceProvider.shutdown()));
  if (meterProvider) chains.push(meterProvider.forceFlush().then(() => meterProvider.shutdown()));
  if (loggerProvider) chains.push(loggerProvider.forceFlush().then(() => loggerProvider.shutdown()));
  if (chains.length === 0) return;
  // Attach a no-op catch so that, if the timeout wins the race, any later
  // rejection from the still-in-flight provider work does not surface as an
  // unhandled rejection. We already record the timeout on `health` below.
  const all = Promise.all(chains).catch(() => {});
  try {
    await Promise.race([
      all,
      timeoutAfter(timeoutMs, "OpenTelemetry shutdown timeout"),
    ]);
  } catch (err) {
    health.lastShutdownError = err instanceof Error ? err.message : String(err);
    // Swallow: a broken collector must never break pi's exit.
  }
}

/** Reject after `ms`. Used to bound shutdown against a dead collector. */
function timeoutAfter(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    t.unref?.();
  });
}

/** A diag logger that drops everything by default. */
function noopDiagLogger(): DiagLogger {
  const noop = () => {};
  return { verbose: noop, debug: noop, info: noop, warn: noop, error: noop };
}

function noopTracer(): Tracer {
  // Full Span surface so a traces-disabled path never throws on a missing
  // method if a caller or future OTel API path exercises more of the type.
  // We build this locally rather than using the global no-op tracer so this
  // module never registers or reads global providers.
  const noopSpan = {
    spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0, isRemote: false }),
    setAttribute() { return this; },
    setAttributes() { return this; },
    addEvent() { return this; },
    addLink() { return this; },
    addLinks() { return this; },
    setStatus() { return this; },
    updateName() { return this; },
    end() {},
    isRecording() { return false; },
    recordException() {},
  };
  return {
    startSpan: () => noopSpan,
    startActiveSpan: (_name: string, ...args: unknown[]) => {
      // OTel overloads: (name, fn) | (name, options, fn) | (name, options, context, fn)
      const fn = args[args.length - 1];
      if (typeof fn === "function") return (fn as (span: typeof noopSpan) => unknown)(noopSpan);
      return noopSpan;
    },
  } as Tracer;
}
