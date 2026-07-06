import { createHash } from "node:crypto";

/**
 * OpenTelemetry attribute constants.
 *
 * Names follow the published semantic conventions:
 *   - GenAI:      https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *   - Resource:   https://opentelemetry.io/docs/specs/semconv/resource/
 *   - HTTP:       https://opentelemetry.io/docs/specs/semconv/http/
 *   - Exceptions: https://opentelemetry.io/docs/specs/semconv/exceptions/
 *
 * `pi.*` attributes are extension-specific and documented in the README.
 * They do not collide with any registered semconv namespace.
 */

// ---------------------------------------------------------------------------
// gen_ai.* (GenAI semantic conventions)
// ---------------------------------------------------------------------------

/** Agent harness identity (pi), not an AI vendor. Do not use as `gen_ai.system` on spans. */
export const GEN_AI_SYSTEM = "pi";

export const ATTR_GEN_AI_SYSTEM = "gen_ai.system";
export const ATTR_GEN_AI_AGENT_NAME = "gen_ai.agent.name";
export const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const ATTR_GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const ATTR_GEN_AI_RESPONSE_ID = "gen_ai.response.id";
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";

// Usage
export const ATTR_GEN_AI_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_GEN_AI_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const ATTR_GEN_AI_TOKEN_TYPE = "gen_ai.token.type";
export const ATTR_GEN_AI_CACHE_READ_TOKENS = "gen_ai.usage.cache_read_input_tokens";
export const ATTR_GEN_AI_CACHE_WRITE_TOKENS = "gen_ai.usage.cache_write_input_tokens";
export const ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS = "gen_ai.usage.cache_write_1h_input_tokens";
export const ATTR_GEN_AI_REASONING_TOKENS = "gen_ai.usage.reasoning_tokens";
export const ATTR_GEN_AI_COST_USD = "gen_ai.usage.cost_usd";

// Tools
export const ATTR_GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const ATTR_GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const ATTR_GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
export const ATTR_GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result";

// Aspire 9.x and similar backends read these JSON-stringified attributes
// on the LLM span instead of (or in addition to) the gen_ai.*.message events.
export const ATTR_GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
export const ATTR_GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";
export const ATTR_GEN_AI_SYSTEM_PROMPT_HASH = "gen_ai.system.prompt.hash";

// gen_ai.* span events (older message-pipeline convention)
export const EVENT_GEN_AI_USER_MESSAGE = "gen_ai.user.message";
export const EVENT_GEN_AI_TOOL_MESSAGE = "gen_ai.tool.message";
export const EVENT_GEN_AI_ASSISTANT_MESSAGE = "gen_ai.assistant.message";
export const EVENT_GEN_AI_CHOICE = "gen_ai.choice";
export const EVENT_GEN_AI_FIRST_TOKEN = "gen_ai.first_token";
export const EVENT_GEN_AI_COMPLETION = "gen_ai.completion";

// ---------------------------------------------------------------------------
// error / http
// ---------------------------------------------------------------------------

export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_EXCEPTION_MESSAGE = "exception.message";
export const ATTR_EXCEPTION_TYPE = "exception.type";
export const ATTR_EXCEPTION_STACKTRACE = "exception.stacktrace";
export const ATTR_HTTP_STATUS_CODE = "http.response.status_code";

// ---------------------------------------------------------------------------
// pi.* (extension-specific)
// ---------------------------------------------------------------------------

export const ATTR_PI_SESSION_ID = "pi.session.id";
export const ATTR_PI_SESSION_FILE = "pi.session.file";
/** Why the pi session started. Values: startup | reload | new | resume | fork. Mirrors pi's SessionStartEvent.reason. */
export const ATTR_PI_SESSION_REASON = "pi.session.reason";
/** Filename stem of the parent session, for new/resume/fork starts. Omitted on startup/reload. */
export const ATTR_PI_SESSION_PARENT_ID = "pi.session.parent_id";
export const ATTR_PI_CWD = "pi.cwd";
export const ATTR_PI_TURN_INDEX = "pi.turn.index";
export const ATTR_PI_TURN_COUNT = "pi.turn_count";
export const ATTR_PI_TOOL_COUNT = "pi.tool_count";
export const ATTR_PI_TOOL_IS_ERROR = "pi.tool.is_error";
export const ATTR_PI_PROMPT_LENGTH = "pi.user_prompt_length";
export const ATTR_PI_USER_PROMPT = "pi.user_prompt";
export const ATTR_PI_INTERACTION_ID = "pi.interaction.id";
export const ATTR_PI_CANCELLED = "pi.cancelled";
export const ATTR_PI_ORPHANED = "pi.orphaned";
export const ATTR_PI_ERROR_COUNT = "pi.error_count";

// ---------------------------------------------------------------------------
// Span names
// ---------------------------------------------------------------------------

export const SPAN_SESSION = "pi.session";
export const SPAN_INTERACTION = "pi.interaction";
export const SPAN_TURN = "pi.turn";
export const SPAN_LLM_REQUEST = "pi.llm_request";
export const spanToolName = (name: string): string => `pi.tool.${name}`;

// ---------------------------------------------------------------------------
// Metric names
// ---------------------------------------------------------------------------

// GenAI semconv metrics
export const METRIC_OP_DURATION = "gen_ai.client.operation.duration";
export const METRIC_TOKEN_USAGE = "gen_ai.client.token.usage";
export const METRIC_TOOL_CALLS = "gen_ai.client.tool.calls";

// pi-namespaced metrics
export const METRIC_SESSION_DURATION = "pi.session.duration";
export const METRIC_PROMPT_COUNT = "pi.prompt.count";
export const METRIC_TURN_COUNT = "pi.turn.count";
export const METRIC_PROVIDER_RETRIES = "pi.provider.retries";
export const METRIC_TURN_CANCELLATIONS = "pi.turn.cancellations";
export const METRIC_COMPACTION_COUNT = "pi.compaction.count";

// ---------------------------------------------------------------------------
// Content capture
// ---------------------------------------------------------------------------

/**
 * Content capture mode.
 * - `metadata_only`: no raw prompt/completion/tool I/O; emit bytes/lines/sha256 only.
 * - `no_tool_content`: add prompt/completion text, but never tool args/results.
 * - `full`: everything (clamped per-attribute).
 *
 * `full` is the default per project requirements. Users handling secrets can
 * dial it back per-project via settings without code changes.
 */
export type ContentCapture = "metadata_only" | "no_tool_content" | "full";

// OTel collectors typically reject attributes larger than 64 KiB. Claude Code
// uses the same ceiling. Larger payloads are truncated with a suffix marker.
const MAX_ATTR_BYTES = 64 * 1024;
const TRUNC_SUFFIX = "…[truncated]";

/**
 * Clamp a value to a byte-safe string attribute. Objects are JSON-serialized
 * with a circular-reference guard. Byte-safe truncation never splits a UTF-8
 * multi-byte sequence.
 */
export function clampAttr(value: unknown): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else if (value instanceof Error) {
    s = value.stack ?? `${value.name}: ${value.message}`;
  } else {
    s = safeStringify(value);
  }
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= MAX_ATTR_BYTES) return s;
  // Shrink until the truncated form fits, leaving room for the suffix.
  let end = MAX_ATTR_BYTES - Buffer.byteLength(TRUNC_SUFFIX, "utf8");
  while (end > 0 && Buffer.byteLength(s.slice(0, end), "utf8") > end) {
    end -= 64;
  }
  // Walk back to a UTF-8 boundary (avoid splitting a multi-byte char).
  while (end > 0 && (s.charCodeAt(end) & 0xc0) === 0xc0) end--; // leading byte
  return `${s.slice(0, end)}${TRUNC_SUFFIX}`;
}

const SAFE_STRINGIFY_REPLACER = (_k: string, v: unknown): unknown => {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
  if (v instanceof Error) {
    return { name: v.name, message: v.message, stack: v.stack };
  }
  if (v && typeof v === "object") {
    if (circularSeen.has(v)) return "[circular]";
    circularSeen.add(v);
  }
  return v;
};

// Per-call WeakSet, reset each invocation.
let circularSeen = new WeakSet<object>();

function safeStringify(value: unknown): string {
  circularSeen = new WeakSet();
  try {
    return JSON.stringify(value, SAFE_STRINGIFY_REPLACER) ?? "null";
  } catch {
    return String(value);
  }
}

/**
 * Structural fingerprint for content we are NOT capturing raw.
 * Lets you correlate/dedupe in the backend without exfiltrating the payload.
 */
/**
 * Stable short SHA-256 hex prefix for a system prompt (one-way; safe to export).
 * Returns undefined for empty or whitespace-only input.
 */
export function hashPrompt(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) return undefined;
  return createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 16);
}

export function fingerprint(value: unknown): Record<string, number | string> {
  const s = typeof value === "string" ? value : safeStringify(value);
  const bytes = Buffer.byteLength(s, "utf8");
  // djb2-style non-crypto hash, hex. Cheap and avoids the node:crypto cost.
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  const lines = s.length === 0 ? 0 : s.split(/\r?\n/).length;
  return {
    bytes,
    lines,
    hash_short: (h >>> 0).toString(16).padStart(8, "0"),
  };
}
