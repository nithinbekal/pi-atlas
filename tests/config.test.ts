import assert from "node:assert/strict";
import test from "node:test";
import { loadLimits } from "../pi/extensions/config.ts";

test("rejects update bounds larger than final file bounds", () => {
  assert.throws(
    () => loadLimits({ ATLAS_MAX_INPUT_BYTES: "101", ATLAS_MAX_FILE_BYTES: "100" }),
    /update limits cannot exceed/,
  );
});

test("rejects oversized compaction line settings instead of generating unwritable output", () => {
  assert.throws(
    () => loadLimits({ ATLAS_MAX_INPUT_LINES: "10", ATLAS_COMPACT_SECTION_LINES: "11" }),
    /compaction line settings cannot exceed the update line limit/,
  );
  assert.throws(
    () => loadLimits({
      ATLAS_MAX_INPUT_LINES: "10",
      ATLAS_COMPACT_SECTION_LINES: "10",
      ATLAS_COMPACT_RECENT_LINES: "11",
    }),
    /compaction line settings cannot exceed the update line limit/,
  );
});
