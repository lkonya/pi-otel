# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-08-18

### Breaking

- The default GenAI attribute set is now the one from semantic-conventions v1.37.0: LLM spans emit `gen_ai.provider.name` (the 2025-10 rename of `gen_ai.system`) and no longer emit `gen_ai.system` or the `gen_ai.user.message`/`gen_ai.assistant.message`/`gen_ai.tool.message`/`gen_ai.choice` events; captured content ships once via the `gen_ai.input.messages`/`gen_ai.output.messages` attributes. The `semconv` setting names the convention release whose set is emitted (`1.36` or `1.37`, default `1.37`); set `PI_OTEL_SEMCONV=1.36` to emit the pre-rename keys and events. Each dialect emits exactly its own attribute set, with no dual-write.
- Timing and tool-count metrics were renamed from the invented `gen_ai.client.time_to_first_token`, `gen_ai.client.time_to_completion`, and `gen_ai.client.tool.calls` to `pi.llm.time_to_first_token`, `pi.llm.time_to_completion`, and `pi.tool.calls`. Those GenAI names appear in no released convention set (verified against semantic-conventions v1.28 through v1.37, whose client metric set is exactly `gen_ai.client.operation.duration` and `gen_ai.client.token.usage`), so only those two keep GenAI names.

### Fixed

- A provider request that failed and then succeeded on retry no longer ends its LLM span with `error.type` and ERROR status, and no longer counts toward the session's `pi.error_count`. Attempt failures are tracked off the span and the final outcome is stamped once at span finalization, so tail-sampling policies keyed on `error.type` no longer keep every transient retry.
- `PI_OTEL_DIAG_LOG_LEVEL` (and `OTEL_LOG_LEVEL`) now route OpenTelemetry SDK diagnostics to stderr at the configured level. The configured level previously filtered messages into a no-op logger, so the knob never produced output.
- The SIGTERM/SIGHUP handlers restore default process termination when no other handler owns the signal after the flush, so the extension can no longer keep a host process alive that would otherwise exit.
- Unrecognized `captureContent` values (for example `metadata-only` or `no_tool`) now resolve to `metadata_only` instead of `full`. An unset value still defaults to `full`. `/otel-status` shows the resolved value.
- The test suite resolves `package.json` relative to the test file; a hardcoded absolute path failed the suite on every checkout except the original author's.

### Added

- Standard OTel env vars now honored: `OTEL_SDK_DISABLED`, `OTEL_EXPORTER_OTLP_TIMEOUT` (and per-signal variants), `OTEL_BSP_*` and `OTEL_BLP_*` batch queue bounds, and `OTEL_TRACES_SAMPLER` sampler selection.
- Batch queue visibility: `/otel-status` shows spans and log records accepted vs exported with an unexported hint when the queue is backed up or exports fail.
- `/otel-test` reports what actually shipped (export deltas) and surfaces export errors; it emits its log record regardless of `selfLogs`. `/otel-status` shows the active trace id.
- The `semconv` setting (env `PI_OTEL_SEMCONV`) selects the GenAI convention release; the `gen_ai.choice` event no longer embeds a duplicate of the assistant message in either dialect.
- GitHub Actions CI: `npm ci`, typecheck, and test on Node 20/22/24 for every push and pull request.
- `npm run coverage` reports per-file line/branch/function coverage using the node:test built-in reporter.

### Changed

- `tsconfig.json` typechecks `test/` alongside `src/`, so type drift in test code now fails `npm run typecheck` instead of passing unseen.

## [0.1.0] - 2026-07-12

Initial release: OTLP traces, metrics, and logs for the pi coding agent with GenAI semantic conventions, per-session SDK lifecycle, content capture modes, and `/otel-status`, `/otel-flush`, `/otel-test` commands.
