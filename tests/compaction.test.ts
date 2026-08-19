import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { archiveStaleDaily, buildCurrentState, compactDaily } from "../pi/extensions/compaction.ts";
import { DEFAULT_LIMITS } from "../pi/extensions/config.ts";
import { MemoryStore } from "../pi/extensions/storage.ts";

const execFileAsync = promisify(execFile);

const DAILY = `## Today's Date: 2026-01-01

**Status**: active

### In Progress

- first
- second
- latest

### Completed

- old completed item

### Key Decisions

- keep raw history
`;

test("current-state compaction selects live sections and bounds each section", () => {
  const result = buildCurrentState(
    DAILY,
    { ...DEFAULT_LIMITS, compactSectionLines: 2, compactRecentLines: 5 },
    new Date("2026-01-02T03:04:05Z"),
  );
  assert.match(result.content, /Generated from daily\.md at 2026-01-02T03:04:05\.000Z/);
  assert.doesNotMatch(result.content, /- first/);
  assert.match(result.content, /- second/);
  assert.match(result.content, /- latest/);
  assert.match(result.content, /keep raw history/);
  assert.doesNotMatch(result.content, /old completed item/);
  assert.deepEqual(result.sections, ["In Progress", "Key Decisions"]);
});

test("compaction snapshots exact raw daily and never modifies daily.md", async () => {
  const parent = await mkdtemp(join(tmpdir(), "atlas-compaction-"));
  const store = new MemoryStore(join(parent, "memory"), DEFAULT_LIMITS);
  await store.replace("daily.md", DAILY);
  const result = await compactDaily(store, DEFAULT_LIMITS, new Date("2026-01-02T03:04:05Z"));
  assert.equal(await store.readText("daily.md"), DAILY);
  assert.equal(await store.readText(result.snapshotPath), DAILY);
  assert.match(await store.readText("current.md"), /# Atlas Current State/);
  assert.match(result.snapshotPath, /^history\/daily\/snapshots\/2026-01-02T03-04-05-000Z-/);
});

test("stale daily rollover copies history before resetting the working file", async () => {
  const parent = await mkdtemp(join(tmpdir(), "atlas-archive-"));
  const store = new MemoryStore(join(parent, "memory"), DEFAULT_LIMITS);
  await store.replace("daily.md", DAILY);
  const archived = await archiveStaleDaily(store, new Date("2026-01-03T00:00:00Z"));
  assert.ok(archived);
  assert.equal(await store.readText(archived!), DAILY);
  assert.match(await store.readText("daily.md"), /Today's Date: 2026-01-03/);
});

test("a delayed rollover holder cannot be reclaimed and lose a concurrent append", async () => {
  const parent = await mkdtemp(join(tmpdir(), "atlas-archive-append-"));
  const root = join(parent, "memory");
  let signalArchive!: () => void;
  const archiveStarted = new Promise<void>((resolve) => { signalArchive = resolve; });
  class DelayedArchiveStore extends MemoryStore {
    override async replace(path: string, content: string): Promise<void> {
      if (path.startsWith("history/daily/")) {
        signalArchive();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return super.replace(path, content);
    }
  }
  const rolloverStore = new DelayedArchiveStore(root, { ...DEFAULT_LIMITS, lockTimeoutMs: 2_000 });
  await rolloverStore.replace("daily.md", DAILY);

  const rollover = archiveStaleDaily(rolloverStore, new Date("2026-01-03T00:00:00Z"));
  await archiveStarted;
  const storageUrl = new URL("../pi/extensions/storage.ts", import.meta.url).href;
  const configUrl = new URL("../pi/extensions/config.ts", import.meta.url).href;
  const script = `
    const [{ MemoryStore }, { DEFAULT_LIMITS }] = await Promise.all([
      import(${JSON.stringify(storageUrl)}), import(${JSON.stringify(configUrl)})
    ]);
    const limits = { ...DEFAULT_LIMITS, lockTimeoutMs: 2000 };
    await new MemoryStore(process.argv[1], limits).append("daily.md", "entry during delayed rollover");
  `;
  const append = execFileAsync(process.execPath, ["--experimental-strip-types", "-e", script, root]);
  const [archived] = await Promise.all([rollover, append]);

  assert.ok(archived);
  assert.equal(await rolloverStore.readText(archived!), DAILY);
  assert.match(await rolloverStore.readText("daily.md"), /entry during delayed rollover/);
});

test("compaction output is capped by update and file bounds even with oversized section settings", () => {
  const limits = {
    ...DEFAULT_LIMITS,
    maxInputBytes: 180,
    maxInputLines: 8,
    maxFileBytes: 180,
    maxFileLines: 8,
    compactSectionLines: Number.MAX_SAFE_INTEGER,
    compactRecentLines: Number.MAX_SAFE_INTEGER,
  };
  const result = buildCurrentState(`${DAILY}${"- extra context\n".repeat(100)}`, limits, new Date("2026-01-02T03:04:05Z"));
  assert.ok(Buffer.byteLength(result.content) <= limits.maxInputBytes);
  assert.ok(result.content.split("\n").length - (result.content.endsWith("\n") ? 1 : 0) <= limits.maxInputLines);
});
