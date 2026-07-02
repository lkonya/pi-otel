/**
 * Metric instrument handles, lazily created from a MeterProvider.
 *
 * Metric names follow GenAI semconv where one exists, else `pi.*`.
 * Histograms are used for distributions (token counts, durations); counters
 * for monotonic totals. Token usage is a histogram (not a counter) per spec,
 * so backends can show p50/p95 token distributions.
 */

import { type Counter, type Histogram, type MeterProvider } from "@opentelemetry/api";

const METER_NAME = "pi-otel";
const METER_VERSION = "0.1.0";

export interface Metrics {
  /** gen_ai.client.operation.duration (s) — LLM request latency. */
  opDuration: Histogram;
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

let cached: Metrics | null = null;

/** Resolve metric handles from the given MeterProvider. Returns null if null is passed. */
export function getMetrics(provider: MeterProvider | null | undefined): Metrics | null {
  if (!provider) return null;
  if (cached) return cached;
  const meter = provider.getMeter(METER_NAME, METER_VERSION);
  // The no-op meter (no provider) returns functional no-op instruments.
  cached = {
    opDuration: meter.createHistogram("gen_ai.client.operation.duration", {
      description: "Duration of GenAI client operations",
      unit: "s",
    }),
    tokenUsage: meter.createHistogram("gen_ai.client.token.usage", {
      description: "Number of tokens used in GenAI client operations",
      unit: "{token}",
    }),
    toolCalls: meter.createCounter("gen_ai.client.tool.calls", {
      description: "Total number of tool calls invoked by the agent",
      unit: "{call}",
    }),
    sessionDuration: meter.createHistogram("pi.session.duration", {
      description: "Duration of a pi session",
      unit: "s",
    }),
    promptCount: meter.createCounter("pi.prompt.count", {
      description: "User prompts (agent interactions)",
      unit: "{prompt}",
    }),
    turnCount: meter.createCounter("pi.turn.count", {
      description: "LLM turns",
      unit: "{turn}",
    }),
    providerRetries: meter.createCounter("pi.provider.retries", {
      description: "Provider HTTP attempts after the first within a single LLM request",
      unit: "{retry}",
    }),
    turnCancellations: meter.createCounter("pi.turn.cancellations", {
      description: "Agent turns cancelled via abort signal",
      unit: "{turn}",
    }),
    compactionCount: meter.createCounter("pi.compaction.count", {
      description: "Context compaction events",
      unit: "{event}",
    }),
  };
  return cached;
}

export function resetMetrics(): void {
  cached = null;
}
