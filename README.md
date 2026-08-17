# pi-otel

OpenTelemetry traces, metrics, and logs for the [pi coding agent](https://github.com/earendil-works/pi).

The extension is a pure OTLP exporter. It speaks the OpenTelemetry wire protocol and emits strict semantic conventions (`gen_ai.*`, `service.*`, `process.*`, `host.*`). Point it at a hosted platform, a collector, or a local dev backend.

## What it emits

All three signals are on by default: traces, metrics, and logs.

**Span tree:**

```
pi.session                       root span, one per session
└─ pi.interaction                one per user prompt
   └─ pi.turn                    one per LLM call plus its tool calls
      ├─ pi.llm_request          CLIENT span, gen_ai.* attributes
      └─ pi.tool.<name>          one per tool call, sibling of the LLM span
```

The LLM span is a `CLIENT` span carrying the GenAI semantic conventions. Backends that understand `gen_ai.*` render it as a model call with token usage, cost, model, and finish reason, no extra configuration on their side.

Tool spans sit as siblings of the LLM span under the turn. Tools run after the model returns, so parenting them under the LLM span would misrepresent causality. Each tool span carries a span link back to the LLM span that triggered it, so backends that render links recover the causality without distorting timing. Several other agent exporters parent tools under the model call.

**Metrics** use the GenAI semconv names where they exist:

- `gen_ai.client.operation.duration` (histogram, seconds)
- `gen_ai.client.time_to_first_token` (histogram, seconds; gap between request start and the first streamed assistant token)
- `gen_ai.client.time_to_completion` (histogram, seconds; gap between request start and the last streamed assistant token, sourced from the `message_end` event)
- `gen_ai.client.token.usage` (histogram, by `gen_ai.token.type`: input, output, cache_read, cache_write, cache_write_1h, reasoning)
- `gen_ai.client.tool.calls` (counter)

Plus a small `pi.*` set for things no semconv covers: `pi.session.duration`, `pi.prompt.count`, `pi.turn.count`, `pi.provider.retries`, `pi.turn.cancellations`, `pi.compaction.count`.

Token usage uses a histogram. The semconv is explicit about this. Histograms let the backend show the p50 and p95 token distribution per request, which a counter cannot.

**Logs** carry `pi.*` lifecycle events: `pi.session.start`, `pi.session.end`, `pi.session.compact`, `pi.model.changed`, `pi.user_bash`, `pi.input`, `pi.llm_request.error`, `pi.tool.error`. Each is a log record with an `event.name` attribute, a severity, and a human-readable body.

## Capabilities

**Works with every OTLP backend.** The export is standard OTLP with strict semantic conventions, so any receiver, hosted or self-hosted, consumes it and handles its own translation. Auth is the standard `OTEL_EXPORTER_OTLP_HEADERS`.

**Speaks GenAI semantic conventions natively.** LLM spans carry the full `gen_ai.*` attribute set: token usage by type, cost, request and response model, response id, finish reasons, tool call id, name, arguments, and result, plus `gen_ai.input.messages` and `gen_ai.output.messages` JSON for AI panels. `gen_ai.system` carries the real provider (`anthropic`, `openai`, `zai`, etc.) so backends group by vendor correctly. `gen_ai.agent.name` is `pi`, the agent harness. Backends that read GenAI semconv render your agent traces as model calls with no extra setup on their side.

**Captures Anthropic's 1-hour cache split.** Anthropic reports cache writes two ways: 5-minute retention and 1-hour retention, at different prices. Most agent exporters fold both into `cache_write` and lose the split, which makes cost analysis wrong. You get both `gen_ai.usage.cache_write_input_tokens` and `gen_ai.usage.cache_write_1h_input_tokens`, so your cost dashboards stay accurate.

**Runs HTTP/protobuf by default, gRPC on demand.** HTTP/protobuf is the OTel spec default, needs no native dependencies, works with every backend on port 4318, and debugs with `curl`. Flip to gRPC with `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` when you want HTTP/2 multiplexing for high telemetry volume.

**Survives `/reload` and session replacement.** Pi reloads extensions per session in the same process. A global provider set on the first session turns into a zombie after `/reload`, dropping every span. The tracker scopes every SDK object (provider, processor, reader, exporter) to a session: created at `session_start`, shut down at every `session_shutdown` (quit, new, resume, fork, reload). A fresh session gets a fresh SDK. The test suite asserts this property.

**Never leaks orphan spans.** Replace a session (`/new`, `/resume`, `/fork`, compaction, tree navigation) or abort a turn with Esc and the tracker closes every open span, marked `pi.orphaned` or `pi.cancelled` so you can tell abandoned spans from normal ones in the backend.

**Tags session origin.** Every session span carries `pi.session.reason` with the value pi reported for the start: `startup`, `reload`, `new`, `resume`, or `fork`. Filter to forks to see branched sessions apart from primary ones.

**Links sessions to their parent.** On `new`, `resume`, and `fork` starts the session span also carries `pi.session.parent_id` (the parent session's filename stem, matching `pi.session.id`). A backend that renders parent links reconstructs the full fork and resume tree for a working session, so you can trace where a branched conversation came from.

**Shuts down on a deadline.** `forceFlush` and `shutdown` race `PI_OTEL_SHUTDOWN_TIMEOUT_MS` (default 2000ms). A dead collector records the failure on `health.lastShutdownError` and pi still exits. A 60s unref'd sweep ends spans open longer than 30 minutes as `pi.orphaned`, including paths that skip `session_shutdown`. SIGTERM and SIGHUP run best-effort shutdown for container stops and closed terminals, and restore default signal termination once the flush finishes when no other handler owns the signal. The extension does not hook `exit` or `beforeExit`.

**Flags provider retries, HTTP errors, and cancellations.** The tracker watches every provider response. HTTP errors land on the LLM span as a categorized `error.type`: `rate_limit`, `server_error`, `auth_error`, `timeout`, `request_too_large`, or `client_error`. Thrown errors map to the same set plus `content_filter`. Retries within a single request bump `pi.provider.retries`, and an aborted turn marks its spans `pi.cancelled` and bumps `pi.turn.cancellations`. Spot rate-limit storms and stuck turns without reading logs.

**Toggle each signal independently.** Turn traces, metrics, or logs on or off with `PI_OTEL_TRACES`, `PI_OTEL_METRICS`, `PI_OTEL_LOGS`, or the matching `otel.traces`, `otel.metrics`, `otel.logs` keys in settings. Run traces-only to cut ingest cost, or logs-only for a lightweight audit feed.

**Picks an exporter per signal.** `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, and `OTEL_LOGS_EXPORTER` accept comma-separated `otlp` (default), `console`, and `none`. Unknown tokens drop. `none` alone disables that signal. `otlp,console` mirrors to stdout for debugging in print and rpc modes. Console strips out when pi runs in TUI mode so JSON does not corrupt the display.

**Session-level summaries and prompt fingerprinting.** Each session span ends with a summary: total input and output tokens, total cost, and an error count, so one row shows the whole session's spend at a glance. Each interaction carries a one-way hash of the assembled system prompt (`gen_ai.system.prompt.hash`) so backends can group sessions by prompt template and A/B iterations without the prompt text leaving the machine.

**Dial content capture per project.** `captureContent` defaults to `full` and ships prompts, completions, and tool input and output to your backend, clamped to 64 KiB per attribute to fit collector limits. Drop to `no_tool_content` to keep prompts but hash tool input and output, the surface where secrets flow. Drop to `metadata_only` to emit only byte counts, line counts, and a hash, with no raw payloads leaving the machine. The hashes still let you correlate and dedupe across sessions without exfiltrating the underlying text. Three modes, no code changes. Unrecognized values resolve to `metadata_only` so a typo cannot turn on full capture; an unset value keeps the `full` default.

**Keeps enduser attribution opt-in.** Resource attributes come from the SDK's host, process, and OS detectors plus explicit `service.*` and `pi.*` values. `process.owner` is the OS username (standard OTel process semconv). The extension never reads git config or invents `enduser.id`. Set `OTEL_RESOURCE_ATTRIBUTES="enduser.id=alice@corp.com"` when you want per-developer attribution.

**Auto-populates rich resource attributes.** The SDK's host, process, OS, and service-instance detectors fill in `host.id`, `host.name`, `process.pid`, `process.executable.*`, `process.command*`, `process.owner`, `process.runtime.*`, `os.*`, and `service.instance.id`. Your backend gets stable host and process identity for filtering and grouping with no manual config.

**Strongly typed against Pi's real event and message shapes.** `src/tracker.ts` mirrors Pi's `Usage`, `AssistantMessage`, `ToolResult`, and `ToolCall` types as structural types instead of reconstructing them with `as any`. Type errors catch drift across Pi versions at compile time, and the runtime tolerates added fields.

**Tunable head sampling.** Sampling defaults to 1.0, every span exported. Set `PI_OTEL_SAMPLE_RATIO` or `OTEL_TRACES_SAMPLER_ARG` below 1.0 to cap ingest cost on a hosted platform without losing representative traffic.

**Built-in pipeline diagnostics.** `/otel-status` prints the resolved config, per-signal endpoints, the last export error from each signal, and counts of exported span, metric, and log batches. `/otel-flush` force-flushes pending telemetry. `/otel-test` emits one synthetic span, one metric, and one log record so you can verify the backend receives all three signals in one step.

**A log channel for your other extensions.** Any pi extension can route structured log records through this exporter with `pi.events.emit("pi-otel:log", ...)`. One observability pipeline for your whole setup.

## Install

```
pi install git:github.com/stnly/pi-otel
```

Then `/reload` in pi, or restart.

This package ships TypeScript source under `src/` and is loaded by pi via jiti. It is not a precompiled library API for general Node imports.

## Quick start

Point the extension at an OTLP/HTTP backend and run pi.

Local Jaeger for development (used here as a local, OTLP-native backend with a built-in trace UI; the extension works with any OTLP receiver):

```bash
docker run --rm -p 16686:16686 -p 4318:4318 \
  -e COLLECTOR_OTLP_ENABLED=true jaegertracing/all-in-one:latest

export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pi
```

Run `/otel-test` in pi. It emits one synthetic span, one metric, and one log record, then force-flushes. Open Jaeger at http://localhost:16686 and look for the `pi.otel.self_test` service. If you see it, the pipeline works. `/otel-status` shows the resolved config and the last export error if anything failed.

### Direct to a hosted platform

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.your-platform.com
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=YOUR_KEY"
pi
```

No collector required.

### Via a collector gateway

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://my-collector:4318
pi
```

Put a collector in front for batching, tail-sampling, redaction, and any platform-specific translation. See [docs/collector-getting-started.md](docs/collector-getting-started.md) for a ready-to-run docker compose setup, a tail-sampling config tuned for agent traces, and prompt-redaction examples.

### gRPC instead of HTTP

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://my-collector:4317
pi
```

## Configuration

Sources, highest precedence first:

1. `OTEL_*` and `PI_OTEL_*` environment variables
2. project `.pi/settings.json` under `otel`
3. global `~/.pi/agent/settings.json` under `otel`

### `.pi/settings.json`

```jsonc
{
  "otel": {
    "enabled": true,
    "endpoint": "https://ingest.your-platform.com",
    "protocol": "http/protobuf",
    "headers": { "x-api-key": "..." },
    "serviceName": "pi",
    "resourceAttributes": { "deployment.env": "dev" },
    "captureContent": "full",
    "sampleRatio": 1.0,
    "metricExportInterval": 10000,
    "tracesExportInterval": 5000,
    "logsExportInterval": 5000,
    "tracesExporters": ["otlp"],
    "metricsExporters": ["otlp"],
    "logsExporters": ["otlp"],
    "traces": true,
    "metrics": true,
    "logs": true,
    "selfLogs": true,
    "diagLogLevel": "none"
  }
}
```

`protocol` accepts `grpc`, `http/protobuf`, or `http/json`. `captureContent` accepts `metadata_only`, `no_tool_content`, or `full`; unrecognized values resolve to `metadata_only`, and an unset value defaults to `full`. `sampleRatio` is a float in [0, 1]; 1.0 means no sampling. `selfLogs` controls whether the extension emits its own `pi.*` lifecycle log records. `diagLogLevel` routes the OpenTelemetry SDK's internal diagnostics to stderr (default `none`).

### Environment variables

Standard OTel, honored verbatim:

`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_TRACES_EXPORT_INTERVAL`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL`, and `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. Metric temporality defaults to `DELTA` when `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` is unset, so cumulative counters from a short-lived agent run do not mislead backends. The preference is passed to the metric exporter constructor; process.env is not mutated. Set the env var yourself to override.

Extension-specific:

`PI_OTEL_ENABLED`, `PI_OTEL_DISABLED`, `PI_OTEL_CAPTURE_CONTENT`, `PI_OTEL_SAMPLE_RATIO`, `PI_OTEL_TRACES`, `PI_OTEL_METRICS`, `PI_OTEL_LOGS`, `PI_OTEL_SELF_LOGS`, `PI_OTEL_DIAG_LOG_LEVEL`, `PI_OTEL_SHUTDOWN_TIMEOUT_MS`. Per-signal exporter env vars `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, and `OTEL_LOGS_EXPORTER` accept `otlp`, `console`, and `none` (comma-separated).

Per-signal exporter tokens and the `DELTA` metric default are described above. `tracesExportInterval` and `logsExportInterval` set each signal's batch processor `scheduledDelayMillis`. `metricExportInterval` sets the metric reader's export interval.

## Commands

| Command | What it does |
|---|---|
| `/otel-status` | Print the resolved config and export health: per-signal exporter lists, shutdown timeout, last error from each signal, last shutdown error, total spans exported, metric export batches, and total log records exported. |
| `/otel-flush` | Force-flush pending telemetry to the backend. |
| `/otel-test` | Emit one synthetic span, one metric, and one log record. Use it to verify the pipeline end to end. |

## Cross-extension log channel

Other pi extensions can route structured log records through this exporter:

```ts
pi.events.emit("pi-otel:log", {
  eventName: "my-extension.something",
  severity: "info",
  body: "human-readable message",
  attributes: { "key": "value" },
});
```

`eventName` lands as the `event.name` attribute. `severity` accepts `trace`, `debug`, `info`, `warn`, `error`, or `fatal`. The call is a no-op when logs are disabled or the runtime is not up.

## Resource attributes

Populated by the SDK detectors plus explicit values:

- `service.name`, `service.version` (the installed pi version), `service.instance.id`
- `host.name`, `host.id` (machine-id on Linux, hostname elsewhere)
- `process.pid`, `process.executable.name`, `process.executable.path`, `process.command`, `process.command_line`, `process.owner`, `process.runtime.name`, `process.runtime.version`
- `os.type`, `os.version`, and friends from the OS detector
- `pi.cwd`, `pi.extension.name`, `pi.extension.version`

Anything you put in `OTEL_RESOURCE_ATTRIBUTES` overrides or extends these.

## Tests

```
npm test
```

Tests span six layers: config resolution, attribute helpers, the span tracker, the SDK lifecycle, the `/otel-status` command, and an end-to-end run over a loopback OTLP/HTTP sink. The end-to-end test replays a full session through a fake `ExtensionAPI` and asserts that traces, metrics, and logs all arrive over HTTP with the documented span names. `npm run typecheck` covers `src/` and `test/`; `npm run coverage` prints a per-file coverage report. CI runs both on Node 20, 22, and 24.

## License

MIT
