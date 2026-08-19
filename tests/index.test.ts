import assert from "node:assert/strict";
import test from "node:test";
import { renderAtlasRead, renderSearchResults } from "../pi/extensions/index.ts";
import { lineCount } from "../pi/extensions/storage.ts";

const OUTPUT_LIMITS = { maxReadBytes: 120, maxReadLines: 3 };

test("atlas_read rendered output includes its notice inside exact configured bounds", () => {
  const text = renderAtlasRead({
    content: "x".repeat(120),
    bytes: 120,
    lines: 1,
    totalBytes: 10_000,
    totalLines: 500,
    truncated: true,
  }, OUTPUT_LIMITS);

  assert.match(text, /Atlas read output truncated/);
  assert.ok(Buffer.byteLength(text) <= OUTPUT_LIMITS.maxReadBytes);
  assert.ok(lineCount(text) <= OUTPUT_LIMITS.maxReadLines);
  assert.equal(Buffer.byteLength(text), OUTPUT_LIMITS.maxReadBytes);
});

test("atlas_search bounds huge descriptions and trigger renderings", () => {
  const text = renderSearchResults([{
    filename: "reference.md",
    description: "description ".repeat(10_000),
    triggers: ["trigger ".repeat(10_000)],
  }], OUTPUT_LIMITS);

  assert.match(text, /Atlas search output truncated/);
  assert.ok(Buffer.byteLength(text) <= OUTPUT_LIMITS.maxReadBytes);
  assert.ok(lineCount(text) <= OUTPUT_LIMITS.maxReadLines);
});
