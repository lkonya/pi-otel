/**
 * Log record emission and message-content helpers.
 *
 * The extension's own lifecycle events are emitted as OTLP log records with an
 * `event.name` attribute, following the OTel "event" semantic convention.
 * The `pi-otel:log` event bus channel lets OTHER pi extensions route their
 * structured logs through this exporter too.
 *
 * The OTel SDK's internal `diag` is never routed back through OTLP — that
 * would recurse. diag stays at NONE unless explicitly raised via OTEL_LOG_LEVEL.
 */

import type { Logger } from "@opentelemetry/api-logs";
import { SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import type { ContentCapture } from "./attrs.js";
import { extensionVersion } from "./version.js";

const LOGGER_NAME = "pi-otel";
const LOGGER_VERSION = extensionVersion();

let cachedLogger: Logger | null = null;

export function resetLogger(): void {
  cachedLogger = null;
}

function logger(provider?: LoggerProvider): Logger | null {
  if (!provider) return null;
  if (!cachedLogger) cachedLogger = provider.getLogger(LOGGER_NAME, LOGGER_VERSION);
  return cachedLogger;
}

const SEVERITY_MAP: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

/**
 * Emit a lifecycle log record. Best-effort: never throws.
 * `eventName` lands as the `event.name` attribute so backends can group
 * discrete events (pi.session.start, pi.tool.error, ...).
 */
export function emitLog(
  provider: LoggerProvider | undefined,
  eventName: string,
  severity: SeverityNumber | keyof typeof SEVERITY_MAP,
  body: string,
  attrs: LogAttributes = {},
): void {
  const log = logger(provider);
  if (!log) return;
  try {
    const sev = typeof severity === "string"
      ? (SEVERITY_MAP[severity] ?? SeverityNumber.INFO)
      : severity;
    log.emit({
      severityNumber: sev,
      severityText: SeverityNumber[sev],
      body,
      attributes: { "event.name": eventName, ...attrs },
    });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Content capture helpers
// ---------------------------------------------------------------------------

/**
 * Decide whether raw content should be attached for a given surface.
 * - prompts/completions: shown when captureContent is `no_tool_content` or `full`.
 * - tool args/results:    shown only when captureContent is `full`.
 */
export function shouldCapturePrompt(c: ContentCapture): boolean {
  return c === "no_tool_content" || c === "full";
}
export function shouldCaptureToolContent(c: ContentCapture): boolean {
  return c === "full";
}
