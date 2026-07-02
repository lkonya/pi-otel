import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { clampAttr, fingerprint, GEN_AI_SYSTEM } from "../src/attrs.ts";

describe("GEN_AI_SYSTEM", () => {
  test("is 'pi'", () => {
    assert.equal(GEN_AI_SYSTEM, "pi");
  });
});

describe("clampAttr", () => {
  test("passes through short strings unchanged", () => {
    assert.equal(clampAttr("hello"), "hello");
  });

  test("serializes objects to JSON", () => {
    assert.equal(clampAttr({ a: 1 }), '{"a":1}');
  });

  test("serializes arrays to JSON", () => {
    assert.equal(clampAttr([1, "two", true]), '[1,"two",true]');
  });

  test("serializes Error to a stack-bearing string", () => {
    const s = clampAttr(new Error("boom"));
    assert.match(s, /Error: boom/);
  });

  test("handles null and undefined without throwing", () => {
    // JSON.stringify(null) === "null" (the 4-char string). For undefined,
    // JSON.stringify returns undefined, which our `?? "null"` fallback turns
    // into the same "null" string.
    assert.equal(clampAttr(null), "null");
    assert.equal(clampAttr(undefined), "null");
  });

  test("handles bigint", () => {
    // bigint: the replacer turns 42n into the string "42", then JSON.stringify
    // wraps that returned string in quotes -> the literal sequence "42".
    assert.equal(clampAttr(42n), '"42"');
  });

  test("handles functions", () => {
    const s = clampAttr(function named() { return 1; });
    // replacer returns '[function named]' (a string) -> JSON re-quotes it.
    assert.equal(s, '"[function named]"');
  });

  test("truncates strings exceeding 64 KiB and keeps total under the limit", () => {
    const big = "x".repeat(70_000);
    const out = clampAttr(big);
    assert.ok(Buffer.byteLength(out, "utf8") <= 64 * 1024, "output must fit under 64 KiB");
    assert.ok(out.endsWith("…[truncated]"), "must end with truncation marker");
    // original content preserved up to the cut point
    assert.ok(out.startsWith("x".repeat(1000)));
  });

  test("truncation is byte-safe (never splits a multi-byte UTF-8 sequence)", () => {
    // '⚡' is 3 bytes in UTF-8. Build a string whose byte length straddles the
    // limit in the middle of a character.
    const char = "⚡";
    const charBytes = Buffer.byteLength(char, "utf8");
    const fill = "a".repeat(64 * 1024 - Math.floor(charBytes / 2));
    const big = fill + char.repeat(100);
    const out = clampAttr(big);
    // The output, decoded as UTF-8, must be valid (no replacement chars from a
    // split sequence). Round-trip through Buffer to validate.
    const decoded = Buffer.from(out, "utf8").toString("utf8");
    assert.ok(decoded.length > 0);
    assert.ok(!decoded.includes("\uFFFD"), "no U+FFFD replacement chars from split multibyte");
  });

  test("handles circular references without throwing", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const s = clampAttr(a);
    assert.match(s, /circular/);
  });

  test("handles nested circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.peer = b;
    b.peer = a;
    const s = clampAttr({ outer: a });
    assert.ok(s.includes('"outer"'));
    // Should not have thrown; output contains a serialization marker.
    assert.ok(s.length > 0);
  });

  test("truncates large objects too", () => {
    const big = { data: "x".repeat(70_000) };
    const out = clampAttr(big);
    assert.ok(Buffer.byteLength(out, "utf8") <= 64 * 1024);
    assert.ok(out.endsWith("…[truncated]"));
  });
});

describe("fingerprint", () => {
  test("returns bytes, lines, and a short hash", () => {
    const fp = fingerprint("hello\nworld");
    assert.equal(fp.bytes, 11);
    assert.equal(fp.lines, 2);
    assert.match(String(fp.sha256_short), /^[0-9a-f]{8}$/);
  });

  test("empty string -> 0 bytes, 0 lines", () => {
    const fp = fingerprint("");
    assert.equal(fp.bytes, 0);
    assert.equal(fp.lines, 0);
  });

  test("same input produces same fingerprint (deterministic)", () => {
    assert.deepEqual(fingerprint("abc"), fingerprint("abc"));
  });

  test("different inputs produce different fingerprints", () => {
    assert.notDeepEqual(fingerprint("abc"), fingerprint("abd"));
  });

  test("accepts non-string input (serialized)", () => {
    const fp = fingerprint({ a: 1 });
    assert.equal(fp.bytes, Buffer.byteLength('{"a":1}', "utf8"));
    assert.equal(fp.lines, 1);
  });

  test("byte count is UTF-8 aware, not char count", () => {
    const fp = fingerprint("⚡"); // 3 bytes, 1 char
    assert.equal(fp.bytes, 3);
  });
});
