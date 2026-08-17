# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- A provider request that failed and then succeeded on retry no longer ends its LLM span with `error.type` and ERROR status, and no longer counts toward the session's `pi.error_count`. Attempt failures are tracked off the span and the final outcome is stamped once at span finalization, so tail-sampling policies keyed on `error.type` no longer keep every transient retry.
- `PI_OTEL_DIAG_LOG_LEVEL` (and `OTEL_LOG_LEVEL`) now route OpenTelemetry SDK diagnostics to stderr at the configured level. The configured level previously filtered messages into a no-op logger, so the knob never produced output.
- The SIGTERM/SIGHUP handlers restore default process termination when no other handler owns the signal after the flush, so the extension can no longer keep a host process alive that would otherwise exit.
- Unrecognized `captureContent` values (for example `metadata-only` or `no_tool`) now resolve to `metadata_only` instead of `full`. An unset value still defaults to `full`. `/otel-status` shows the resolved value.
- The test suite resolves `package.json` relative to the test file; a hardcoded absolute path failed the suite on every checkout except the original author's.

### Changed

- `tsconfig.json` typechecks `test/` alongside `src/`, so type drift in test code now fails `npm run typecheck` instead of passing unseen.

### Added

- GitHub Actions CI: `npm ci`, typecheck, and test on Node 20/22/24 for every push and pull request.
- `npm run coverage` reports per-file line/branch/function coverage using the node:test built-in reporter.

## [0.1.0] - 2026-07-12

Initial release: OTLP traces, metrics, and logs for the pi coding agent with GenAI semantic conventions, per-session SDK lifecycle, content capture modes, and `/otel-status`, `/otel-flush`, `/otel-test` commands.
