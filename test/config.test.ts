import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveConfig,
  resolveSignalEndpoint,
  parseExporters,
  parseExporterTokensFromArray,
  clampExportIntervalMs,
  clampShutdownTimeoutMs,
  MIN_EXPORT_INTERVAL_MS,
} from "../src/config.ts";

/**
 * Config resolution tests.
 *
 * Precedence under test: env > project settings > global settings > defaults.
 * Each test saves/restores the full set of env vars it touches to avoid
 * cross-test contamination.
 */

const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SERVICE_NAME",
  "OTEL_TRACES_SAMPLER_ARG",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_TRACES_EXPORT_INTERVAL",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_LEVEL",
  "PI_OTEL_ENABLED",
  "PI_OTEL_DISABLED",
  "PI_OTEL_CAPTURE_CONTENT",
  "PI_OTEL_SAMPLE_RATIO",
  "PI_OTEL_TRACES",
  "PI_OTEL_METRICS",
  "PI_OTEL_LOGS",
  "PI_OTEL_SERVICE_NAME",
  "PI_OTEL_SHUTDOWN_TIMEOUT_MS",
  "PI_OTEL_METRIC_EXPORT_INTERVAL",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// --- resolveSignalEndpoint --------------------------------------------------

describe("resolveSignalEndpoint", () => {
  test("appends /v1/<signal> for http/protobuf", () => {
    assert.equal(resolveSignalEndpoint("http://localhost:4318", "traces", "http/protobuf"), "http://localhost:4318/v1/traces");
    assert.equal(resolveSignalEndpoint("http://x:4318", "metrics", "http/protobuf"), "http://x:4318/v1/metrics");
    assert.equal(resolveSignalEndpoint("http://x:4318", "logs", "http/json"), "http://x:4318/v1/logs");
  });

  test("returns base unchanged for grpc", () => {
    assert.equal(resolveSignalEndpoint("http://localhost:4317", "traces", "grpc"), "http://localhost:4317");
    assert.equal(resolveSignalEndpoint("http://localhost:4317/", "metrics", "grpc"), "http://localhost:4317");
  });

  test("explicit endpoint wins over base for any protocol", () => {
    assert.equal(
      resolveSignalEndpoint("http://base:4318", "traces", "grpc", "https://explicit/traces"),
      "https://explicit/traces",
    );
  });

  test("does not double-append when base already has a /v1/<signal> path", () => {
    assert.equal(
      resolveSignalEndpoint("http://x:4318/v1/traces", "traces", "http/protobuf"),
      "http://x:4318/v1/traces",
    );
  });

  test("trims trailing slashes before appending", () => {
    assert.equal(resolveSignalEndpoint("http://x:4318///", "traces", "http/protobuf"), "http://x:4318/v1/traces");
  });
});

// --- defaults ---------------------------------------------------------------

describe("defaults", () => {
  test("all three signals enabled by default", () => {
    const c = resolveConfig("/nonexistent");
    assert.equal(c.traces.enabled, true);
    assert.equal(c.metrics.enabled, true);
    assert.equal(c.logs.enabled, true);
  });

  test("default protocol is http/protobuf per OTel spec", () => {
    const c = resolveConfig("/nonexistent");
    assert.equal(c.protocol, "http/protobuf");
  });

  test("default endpoint is localhost:4318", () => {
    const c = resolveConfig("/nonexistent");
    assert.equal(c.endpoint, "http://localhost:4318");
    assert.equal(c.tracesEndpoint, "http://localhost:4318/v1/traces");
  });

  test("default service.name is pi", () => {
    assert.equal(resolveConfig("/nonexistent").serviceName, "pi");
  });

  test("default captureContent is full", () => {
    assert.equal(resolveConfig("/nonexistent").captureContent, "full");
  });

  test("default sampleRatio is 1.0 (no sampling)", () => {
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 1);
  });

  test("enabled is true by default", () => {
    assert.equal(resolveConfig("/nonexistent").enabled, true);
  });

  test("default exporter tokens and export intervals", () => {
    const c = resolveConfig("/nonexistent");
    assert.deepEqual(c.tracesExporters, ["otlp"]);
    assert.deepEqual(c.metricsExporters, ["otlp"]);
    assert.deepEqual(c.logsExporters, ["otlp"]);
    assert.equal(c.tracesExportInterval, 5000);
    assert.equal(c.metricExportInterval, 10000);
    assert.equal(c.logsExportInterval, 5000);
  });
});

// --- precedence -------------------------------------------------------------

describe("precedence", () => {
  test("OTEL_SERVICE_NAME overrides settings serviceName", () => {
    process.env.OTEL_SERVICE_NAME = "from-env";
    assert.equal(resolveConfig("/nonexistent").serviceName, "from-env");
  });

  test("PI_OTEL_SERVICE_NAME overrides settings serviceName", () => {
    process.env.PI_OTEL_SERVICE_NAME = "from-pi-env";
    assert.equal(resolveConfig("/nonexistent").serviceName, "from-pi-env");
  });

  test("OTEL_EXPORTER_OTLP_ENDPOINT overrides default endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://ingest.example.com";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.tracesEndpoint, "https://ingest.example.com/v1/traces");
    assert.equal(c.metricsEndpoint, "https://ingest.example.com/v1/metrics");
    assert.equal(c.logsEndpoint, "https://ingest.example.com/v1/logs");
  });

  test("per-signal endpoint overrides beat base endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://base:4318";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://traces-only:4318/v1/traces";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.tracesEndpoint, "https://traces-only:4318/v1/traces");
    assert.equal(c.metricsEndpoint, "http://base:4318/v1/metrics");
  });

  test("OTEL_EXPORTER_OTLP_HEADERS merge into headers map", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-api-key=secret,region=us";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.headers["x-api-key"], "secret");
    assert.equal(c.headers["region"], "us");
  });

  test("OTEL_RESOURCE_ATTRIBUTES parsed (URL-decoded) into resourceAttributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.env=prod,team=platform%20eng";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.resourceAttributes["deployment.env"], "prod");
    assert.equal(c.resourceAttributes["team"], "platform eng");
  });

  test("malformed OTEL_RESOURCE_ATTRIBUTES percent-escape keeps raw value", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "bad=%%%";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.resourceAttributes["bad"], "%%%");
  });
});

// --- protocol normalization -------------------------------------------------

describe("protocol normalization", () => {
  for (const [raw, expected] of [
    ["grpc", "grpc"],
    ["gRPC", "grpc"],
    ["http/protobuf", "http/protobuf"],
    ["http", "http/protobuf"],
    ["http-protobuf", "http/protobuf"],
    ["http/json", "http/json"],
    ["", "http/protobuf"],
    ["garbage", "http/protobuf"],
  ] as const) {
    test(`protocol "${raw}" -> ${expected}`, () => {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = raw;
      assert.equal(resolveConfig("/nonexistent").protocol, expected);
    });
  }
});

// --- capture normalization --------------------------------------------------

describe("capture normalization", () => {
  for (const [raw, expected] of [
    ["full", "full"],
    ["metadata_only", "metadata_only"],
    ["no_tool_content", "no_tool_content"],
    ["1", "full"],
    ["true", "full"],
    ["", "full"],
    ["garbage", "full"],
  ] as const) {
    test(`capture "${raw}" -> ${expected}`, () => {
      process.env.PI_OTEL_CAPTURE_CONTENT = raw;
      assert.equal(resolveConfig("/nonexistent").captureContent, expected);
    });
  }
});

// --- enable/disable ---------------------------------------------------------

describe("enable/disable", () => {
  test("PI_OTEL_ENABLED=false disables", () => {
    process.env.PI_OTEL_ENABLED = "false";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });

  test("PI_OTEL_ENABLED=0 disables", () => {
    process.env.PI_OTEL_ENABLED = "0";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });

  test("PI_OTEL_DISABLED=1 wins over PI_OTEL_ENABLED=true", () => {
    process.env.PI_OTEL_ENABLED = "true";
    process.env.PI_OTEL_DISABLED = "1";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });

  test("PI_OTEL_DISABLED=true also works", () => {
    process.env.PI_OTEL_DISABLED = "true";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });
});

// --- per-signal toggles -----------------------------------------------------

describe("per-signal toggles", () => {
  test("PI_OTEL_TRACES=0 disables traces only", () => {
    process.env.PI_OTEL_TRACES = "0";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.traces.enabled, false);
    assert.equal(c.metrics.enabled, true);
    assert.equal(c.logs.enabled, true);
  });

  test("PI_OTEL_LOGS=false disables logs only", () => {
    process.env.PI_OTEL_LOGS = "false";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.logs.enabled, false);
    assert.equal(c.traces.enabled, true);
  });
});

// --- sampling ---------------------------------------------------------------

describe("sampling", () => {
  test("sampleRatio is clamped to [0,1]", () => {
    process.env.PI_OTEL_SAMPLE_RATIO = "5";
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 1);
    process.env.PI_OTEL_SAMPLE_RATIO = "-0.5";
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 0);
  });

  test("OTEL_TRACES_SAMPLER_ARG is honored", () => {
    process.env.OTEL_TRACES_SAMPLER_ARG = "0.25";
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 0.25);
  });

  test("non-numeric sampleRatio falls back to default", () => {
    process.env.PI_OTEL_SAMPLE_RATIO = "abc";
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 1);
  });
});

// --- exporter tokens --------------------------------------------------------

describe("parseExporters", () => {
  const defaultFallback: ["otlp"] = ["otlp"];

  test("single token console", () => {
    assert.deepEqual(parseExporters("console", defaultFallback), ["console"]);
  });

  test("comma list with mixed case and whitespace", () => {
    assert.deepEqual(parseExporters(" Console , OTLP ", defaultFallback), ["console", "otlp"]);
  });

  test("dedupe preserves order", () => {
    assert.deepEqual(parseExporters("otlp,otlp", defaultFallback), ["otlp"]);
  });

  test("none token preserved", () => {
    assert.deepEqual(parseExporters("none", defaultFallback), ["none"]);
  });

  test("all unknown tokens fall back", () => {
    assert.deepEqual(parseExporters("foo,bar,baz", defaultFallback), ["otlp"]);
  });

  test("empty string falls back", () => {
    assert.deepEqual(parseExporters("", defaultFallback), ["otlp"]);
    assert.deepEqual(parseExporters("   ", defaultFallback), ["otlp"]);
  });

  test("unknown mixed with known keeps known", () => {
    assert.deepEqual(parseExporters("otlp,garbage,console", defaultFallback), ["otlp", "console"]);
  });

  test("undefined falls back", () => {
    assert.deepEqual(parseExporters(undefined, defaultFallback), ["otlp"]);
  });
});

describe("parseExporterTokensFromArray", () => {
  const defaultFallback: ["otlp"] = ["otlp"];

  test("validates settings array entries", () => {
    assert.deepEqual(parseExporterTokensFromArray(["otlp", "bogus", "console"], defaultFallback), [
      "otlp",
      "console",
    ]);
  });

  test("empty array falls back", () => {
    assert.deepEqual(parseExporterTokensFromArray([], defaultFallback), ["otlp"]);
    assert.deepEqual(parseExporterTokensFromArray(undefined, defaultFallback), ["otlp"]);
  });
});

describe("exporter env precedence", () => {
  test("OTEL_TRACES_EXPORTER single console", () => {
    process.env.OTEL_TRACES_EXPORTER = "console";
    assert.deepEqual(resolveConfig("/nonexistent").tracesExporters, ["console"]);
  });

  test("OTEL_METRICS_EXPORTER mixed case list", () => {
    process.env.OTEL_METRICS_EXPORTER = " Console , OTLP ";
    assert.deepEqual(resolveConfig("/nonexistent").metricsExporters, ["console", "otlp"]);
  });

  test("OTEL_LOGS_EXPORTER dedupes", () => {
    process.env.OTEL_LOGS_EXPORTER = "otlp,otlp";
    assert.deepEqual(resolveConfig("/nonexistent").logsExporters, ["otlp"]);
  });
});

describe("export intervals", () => {
  test("OTEL_TRACES_EXPORT_INTERVAL numeric", () => {
    process.env.OTEL_TRACES_EXPORT_INTERVAL = "1500";
    assert.equal(resolveConfig("/nonexistent").tracesExportInterval, 1500);
  });

  test("OTEL_LOGS_EXPORT_INTERVAL non-numeric falls back", () => {
    process.env.OTEL_LOGS_EXPORT_INTERVAL = "abc";
    assert.equal(resolveConfig("/nonexistent").logsExportInterval, 5000);
  });

  test("zero and negative export intervals clamp to the minimum", () => {
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "0";
    process.env.OTEL_TRACES_EXPORT_INTERVAL = "-50";
    process.env.OTEL_LOGS_EXPORT_INTERVAL = "1";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.metricExportInterval, MIN_EXPORT_INTERVAL_MS);
    assert.equal(c.tracesExportInterval, MIN_EXPORT_INTERVAL_MS);
    assert.equal(c.logsExportInterval, MIN_EXPORT_INTERVAL_MS);
  });

  test("fractional export intervals truncate toward the floor after clamp", () => {
    process.env.OTEL_TRACES_EXPORT_INTERVAL = "1500.9";
    assert.equal(resolveConfig("/nonexistent").tracesExportInterval, 1500);
  });

  test("shutdown timeout allows 0 and clamps negatives to 0", () => {
    process.env.PI_OTEL_SHUTDOWN_TIMEOUT_MS = "0";
    assert.equal(resolveConfig("/nonexistent").shutdownTimeoutMs, 0);
    process.env.PI_OTEL_SHUTDOWN_TIMEOUT_MS = "-10";
    assert.equal(resolveConfig("/nonexistent").shutdownTimeoutMs, 0);
  });

  test("shutdown timeout non-numeric falls back to default", () => {
    process.env.PI_OTEL_SHUTDOWN_TIMEOUT_MS = "nope";
    assert.equal(resolveConfig("/nonexistent").shutdownTimeoutMs, 2000);
  });
});

describe("clamp helpers", () => {
  test("clampExportIntervalMs floors and rejects non-finite", () => {
    assert.equal(clampExportIntervalMs(0, 5000), MIN_EXPORT_INTERVAL_MS);
    assert.equal(clampExportIntervalMs(-1, 5000), MIN_EXPORT_INTERVAL_MS);
    assert.equal(clampExportIntervalMs(250, 5000), 250);
    assert.equal(clampExportIntervalMs(Number.NaN, 5000), 5000);
    assert.equal(clampExportIntervalMs(Number.POSITIVE_INFINITY, 5000), 5000);
  });

  test("clampShutdownTimeoutMs allows zero", () => {
    assert.equal(clampShutdownTimeoutMs(0, 2000), 0);
    assert.equal(clampShutdownTimeoutMs(-5, 2000), 0);
    assert.equal(clampShutdownTimeoutMs(1500, 2000), 1500);
    assert.equal(clampShutdownTimeoutMs(Number.NaN, 2000), 2000);
  });
});

// --- settings.json files ----------------------------------------------------

describe("settings.json", () => {
  test("project .pi/settings.json otel block is read", () => {
    const tmp = mkProjectSettings({ otel: { serviceName: "from-project", sampleRatio: 0.5 } });
    try {
      const c = resolveConfig(tmp);
      assert.equal(c.serviceName, "from-project");
      assert.equal(c.sampleRatio, 0.5);
    } finally {
      rmrf(tmp);
    }
  });

  test("env overrides project settings", () => {
    const tmp = mkProjectSettings({ otel: { serviceName: "from-project" } });
    try {
      process.env.OTEL_SERVICE_NAME = "from-env";
      assert.equal(resolveConfig(tmp).serviceName, "from-env");
    } finally {
      rmrf(tmp);
    }
  });

  test("malformed settings.json is tolerated (defaults used)", () => {
    const tmp = makeTmpDir();
    fs.mkdirSync(node_path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(node_path.join(tmp, ".pi", "settings.json"), "{ not valid json");
    try {
      const c = resolveConfig(tmp);
      assert.equal(c.serviceName, "pi"); // default
      assert.equal(c.enabled, true);
    } finally {
      rmrf(tmp);
    }
  });

  test("settings.json without otel key is tolerated", () => {
    const tmp = mkProjectSettings({ other: { foo: "bar" } });
    try {
      const c = resolveConfig(tmp);
      assert.equal(c.serviceName, "pi");
    } finally {
      rmrf(tmp);
    }
  });

  test("settings resourceAttributes merge under env OTEL_RESOURCE_ATTRIBUTES", () => {
    const tmp = mkProjectSettings({
      otel: {
        resourceAttributes: { "deployment.env": "from-settings", team: "settings-team" },
      },
    });
    try {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.env=from-env,region=us";
      const c = resolveConfig(tmp);
      assert.equal(c.resourceAttributes["deployment.env"], "from-env", "env overrides settings");
      assert.equal(c.resourceAttributes.team, "settings-team", "settings-only key kept");
      assert.equal(c.resourceAttributes.region, "us", "env-only key present");
    } finally {
      rmrf(tmp);
    }
  });
});

// --- helpers ----------------------------------------------------------------

import fs from "node:fs";
import node_path from "node:path";
import os from "node:os";

function makeTmpDir(): string {
  return fs.mkdtempSync(node_path.join(os.tmpdir(), "pi-otel-cfg-"));
}
function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}
function mkProjectSettings(contents: Record<string, unknown>): string {
  const dir = makeTmpDir();
  fs.mkdirSync(node_path.join(dir, ".pi"), { recursive: true });
  fs.writeFileSync(node_path.join(dir, ".pi", "settings.json"), JSON.stringify(contents));
  return dir;
}
