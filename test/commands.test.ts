import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../src/commands.ts";
import { resolveConfig, type ResolvedConfig } from "../src/config.ts";
import type { ExportHealth, TelemetryRuntime } from "../src/sdk.ts";

type CommandHandler = (args: unknown, ctx: ExtensionContext) => Promise<void>;

function captureRegisterCommands(getRuntime: () => TelemetryRuntime | null): {
  commands: Record<string, { handler: CommandHandler }>;
  runStatus: () => Promise<string>;
} {
  const commands: Record<string, { handler: CommandHandler }> = {};
  const fakePi = {
    registerCommand: (name: string, def: { handler: CommandHandler }) => {
      commands[name] = def;
    },
  } as unknown as ExtensionAPI;
  registerCommands(fakePi, getRuntime);

  async function runStatus(): Promise<string> {
    const fakeCtx = { hasUI: false } as unknown as ExtensionContext;
    const orig = console.log;
    let captured = "";
    try {
      console.log = (s: string) => {
        captured = s;
      };
      await commands["otel-status"]!.handler([], fakeCtx);
    } finally {
      console.log = orig;
    }
    return captured;
  }

  return { commands, runStatus };
}

function minimalRuntime(
  configOverrides: Partial<ResolvedConfig>,
  health: ExportHealth,
): TelemetryRuntime {
  const base = resolveConfig("/test");
  const config = { ...base, ...configOverrides };
  return { config, health } as TelemetryRuntime;
}

const EXPECTED_LABELS = [
  "enabled",
  "endpoint",
  "traces",
  "traces exporters",
  "metrics",
  "metrics exporters",
  "logs",
  "logs exporters",
  "protocol",
  "service.name",
  "captureContent",
  "sampleRatio",
  "shutdown timeout",
  "exported spans",
  "metric batches",
  "log records",
  "last shutdown err",
] as const;

/** Label field is 19 characters; values begin at 0-based index 19. */
function assertLabelColumnAligned(text: string, valueStart = 19): void {
  const lines = text.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    assert.ok(line.length > valueStart, `line too short for aligned column: ${line}`);
    assert.equal(
      line.charAt(valueStart - 1),
      " ",
      `label column must be ${valueStart} chars (space-padded), line: ${line}`,
    );
  }
}

describe("otel-status command", () => {
  test("renders all expected lines with correct labels and alignment", async () => {
    const endpoint = "https://otel.example:4318";
    const serviceName = "pi-status-test";
    const shutdownTimeoutMs = 4500;
    const health: ExportHealth = {
      spansExported: 12,
      metricBatchesExported: 3,
      logRecordsExported: 7,
    };
    const { runStatus } = captureRegisterCommands(() =>
      minimalRuntime(
        {
          endpoint,
          serviceName,
          shutdownTimeoutMs,
          tracesExporters: ["otlp", "console"],
          metricsExporters: ["otlp"],
          logsExporters: ["none"],
        },
        health,
      ),
    );

    const text = await runStatus();

    for (const label of EXPECTED_LABELS) {
      assert.ok(text.includes(label), `missing label: ${label}`);
    }
    assertLabelColumnAligned(text);
    assert.ok(text.includes(`endpoint           ${endpoint}`));
    assert.ok(text.includes(`service.name       ${serviceName}`));
    assert.ok(text.includes("traces exporters   otlp,console"));
    assert.ok(text.includes(`shutdown timeout   ${shutdownTimeoutMs}`));
    assert.ok(text.includes("last shutdown err  (none)"));
    assert.ok(text.includes("exported spans     12"));
    assert.ok(text.includes("metric batches     3"));
    assert.ok(text.includes("log records        7"));
  });

  test("signals off render as (off)", async () => {
    const base = resolveConfig("/test");
    const health: ExportHealth = {
      spansExported: 0,
      metricBatchesExported: 0,
      logRecordsExported: 0,
    };
    const { runStatus } = captureRegisterCommands(() =>
      minimalRuntime(
        {
          traces: { enabled: false },
          tracesEndpoint: base.tracesEndpoint,
        },
        health,
      ),
    );

    const text = await runStatus();
    assert.ok(text.includes("traces             (off)"));
    assert.ok(!text.match(/^traces             \(off\).*ERROR:/m), "off traces must not show ERROR suffix");
  });

  test("export errors surface inline", async () => {
    const health: ExportHealth = {
      spansExported: 0,
      metricBatchesExported: 0,
      logRecordsExported: 0,
      tracesError: "connection refused",
    };
    const { runStatus } = captureRegisterCommands(() => minimalRuntime({}, health));

    const text = await runStatus();
    const tracesLine = text.split("\n").find((l) => l.startsWith("traces             "));
    assert.ok(tracesLine, "traces line present");
    assert.ok(tracesLine!.endsWith("ERROR: connection refused"));
  });

  test("last shutdown error renders when set", async () => {
    const health: ExportHealth = {
      spansExported: 0,
      metricBatchesExported: 0,
      logRecordsExported: 0,
      lastShutdownError: "OpenTelemetry shutdown timeout",
    };
    const { runStatus } = captureRegisterCommands(() => minimalRuntime({}, health));

    const text = await runStatus();
    assert.ok(text.includes("last shutdown err  OpenTelemetry shutdown timeout"));
  });

  test("no-runtime path returns the disabled message", async () => {
    const { runStatus } = captureRegisterCommands(() => null);
    const text = await runStatus();
    assert.equal(text, "pi-otel: disabled (no telemetry runtime)");
  });
});

describe("otel-flush and otel-test commands", () => {
  // These commands must work headless (hasUI: false). An earlier version
  // called ctx.ui.notify unconditionally in otel-flush/otel-test and would
  // throw when pi ran without a UI.
  function captureLog(fn: () => Promise<void>): Promise<string> {
    const fakeCtx = { hasUI: false } as unknown as ExtensionContext;
    const orig = console.log;
    let captured = "";
    return (async () => {
      try {
        console.log = (s: string) => { captured = s; };
        await fn();
      } finally {
        console.log = orig;
      }
      // otel-test may emit multiple lines (warning prefix); keep the last.
      void fakeCtx;
      return captured;
    })();
  }

  test("otel-flush does not throw headless and prints a confirmation", async () => {
    let flushed = false;
    const rt = minimalRuntime({}, { spansExported: 0, metricBatchesExported: 0, logRecordsExported: 0 });
    rt.flush = async () => { flushed = true; };
    const { commands } = captureRegisterCommands(() => rt);
    const fakeCtx = { hasUI: false } as unknown as ExtensionContext;
    await commands["otel-flush"]!.handler([], fakeCtx); // must not throw
    assert.equal(flushed, true, "flush was called");
    const out = await captureLog(() => commands["otel-flush"]!.handler([], fakeCtx));
    assert.match(out, /pi-otel: flushed/);
  });

  test("otel-test does not throw headless with all signals disabled", async () => {
    const rt = minimalRuntime(
      { traces: { enabled: false }, metrics: { enabled: false }, logs: { enabled: false } },
      { spansExported: 0, metricBatchesExported: 0, logRecordsExported: 0 },
    );
    rt.flush = async () => {};
    const { commands } = captureRegisterCommands(() => rt);
    const out = await captureLog(() => commands["otel-test"]!.handler([], { hasUI: false } as unknown as ExtensionContext));
    assert.match(out, /all signals disabled/);
  });

  test("otel-flush with no runtime prints the disabled message headless", async () => {
    const { commands } = captureRegisterCommands(() => null);
    const out = await captureLog(() => commands["otel-flush"]!.handler([], { hasUI: false } as unknown as ExtensionContext));
    assert.match(out, /pi-otel: disabled/);
  });
});