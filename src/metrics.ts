/**
 * Metric instrument handles, created from a MeterProvider.
 *
 * Metric names follow GenAI semconv where one exists, else `pi.*`.
 * Histograms are used for distributions (token counts, durations); counters
 * for monotonic totals. Token usage is a histogram (not a counter) per spec,
 * so backends can show p50/p95 token distributions.
 *
 * Instruments are bound to the provider passed in. There is no process-wide
 * cache: each TelemetryRuntime owns its own Metrics instance so a reload
 * cannot keep writing to a shut-down provider.
 */

import { type Counter, type Histogram, type MeterProvider } from "@opentelemetry/api";
import { extensionVersion } from "./version.js";
import {
  METRIC_OP_DURATION,
  METRIC_TOKEN_USAGE,
  METRIC_TOOL_CALLS,
  METRIC_SESSION_DURATION,
  METRIC_PROMPT_COUNT,
  METRIC_TURN_COUNT,
  METRIC_PROVIDER_RETRIES,
  METRIC_TURN_CANCELLATIONS,
  METRIC_COMPACTION_COUNT,
} from "./attrs.js";

const METER_NAME = "pi-otel";
const METER_VERSION = extensionVersion();

export interface Metrics {
  /** gen_ai.client.operation.duration (s) — LLM request latency. */
  opDuration: Histogram;
  /** gen_ai.client.time_to_first_token (s) — request start to first streamed token. */
  timeToFirstToken: Histogram;
  /** gen_ai.client.time_to_completion (s) — request start to final assistant token. */
  timeToCompletion: Histogram;
  /** gen_ai.client.token.usage ({token}) — tokens per LLM request, by token type. */
  tokenUsage: Histogram;
  /** gen_ai.client.tool.calls ({call}) — tool invocations. */
  toolCalls: Counter;
  /** pi.session.duration (s). */
  sessionDuration: Histogram;
  /** pi.prompt.count — user prompts (agent interactions). */
  promptCount: Counter;
  /** pi.turn.count — LLM turns. */
  turnCount: Counter;
  /** pi.provider.retries — provider HTTP retries within a request. */
  providerRetries: Counter;
  /** pi.turn.cancellations — turns aborted via signal. */
  turnCancellations: Counter;
  /** pi.compaction.count — context compaction events. */
  compactionCount: Counter;
}

/** Create metric handles bound to this MeterProvider. Returns null if no provider. */
export function createMetrics(provider: MeterProvider | null | undefined): Metrics | null {
  if (!provider) return null;
  const meter = provider.getMeter(METER_NAME, METER_VERSION);
  return {
    opDuration: meter.createHistogram(METRIC_OP_DURATION, {
      description: "Duration of GenAI client operations",
      unit: "s",
    }),
    timeToFirstToken: meter.createHistogram("gen_ai.client.time_to_first_token", {
      description: "Time from LLM request start to first streamed token",
      unit: "s",
    }),
    timeToCompletion: meter.createHistogram("gen_ai.client.time_to_completion", {
      description: "Duration of GenAI client operations from request start to completion",
      unit: "s",
    }),
    tokenUsage: meter.createHistogram(METRIC_TOKEN_USAGE, {
      description: "Number of tokens used in GenAI client operations",
      unit: "{token}",
    }),
    toolCalls: meter.createCounter(METRIC_TOOL_CALLS, {
      description: "Total number of tool calls invoked by the agent",
      unit: "{call}",
    }),
    sessionDuration: meter.createHistogram(METRIC_SESSION_DURATION, {
      description: "Duration of a pi session",
      unit: "s",
    }),
    promptCount: meter.createCounter(METRIC_PROMPT_COUNT, {
      description: "User prompts (agent interactions)",
      unit: "{prompt}",
    }),
    turnCount: meter.createCounter(METRIC_TURN_COUNT, {
      description: "LLM turns",
      unit: "{turn}",
    }),
    providerRetries: meter.createCounter(METRIC_PROVIDER_RETRIES, {
      description: "Provider HTTP attempts after the first within a single LLM request",
      unit: "{retry}",
    }),
    turnCancellations: meter.createCounter(METRIC_TURN_CANCELLATIONS, {
      description: "Agent turns cancelled via abort signal",
      unit: "{turn}",
    }),
    compactionCount: meter.createCounter(METRIC_COMPACTION_COUNT, {
      description: "Context compaction events",
      unit: "{event}",
    }),
  };
}
