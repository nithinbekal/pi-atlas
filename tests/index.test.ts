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

test("atlas_search lists indexed files when nothing matches", () => {
  const text = renderSearchResults([], { maxReadBytes: 10_000, maxReadLines: 50 }, [
    { filename: "knowledge/team.md", description: "Team membership", triggers: ["team"] },
  ]);

  assert.equal(text, "No matching knowledge files found. Indexed files:\n- knowledge/team.md: Team membership");
});

test("atlas_search does not double the knowledge/ prefix", () => {
  const text = renderSearchResults([
    { filename: "knowledge/team.md", description: "Team membership", triggers: ["team"] },
  ], { maxReadBytes: 10_000, maxReadLines: 50 });

  assert.match(text, /^Found 1 matching knowledge file\(s\):\n- knowledge\/team\.md \(matched: team; Team membership\)$/);
});
