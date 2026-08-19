import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_LIMITS } from "../pi/extensions/config.ts";
import { lineCount, MemoryStore, truncateHead, truncateTail } from "../pi/extensions/storage.ts";

const execFileAsync = promisify(execFile);

async function fixture(overrides = {}) {
  const parent = await mkdtemp(join(tmpdir(), "atlas-storage-"));
  const root = join(parent, "memory");
  return { parent, root, store: new MemoryStore(root, { ...DEFAULT_LIMITS, ...overrides }) };
}

test("head and tail truncation obey exact byte and logical-line boundaries", () => {
  const text = "a\nb\nc\n";
  assert.deepEqual(truncateHead(text, 100, 2), {
    content: "a\nb\n",
    bytes: 4,
    lines: 2,
    totalBytes: 6,
    totalLines: 3,
    truncated: true,
  });
  assert.deepEqual(truncateTail(text, 100, 2), {
    content: "b\nc\n",
    bytes: 4,
    lines: 2,
    totalBytes: 6,
    totalLines: 3,
    truncated: true,
  });
  for (const bounded of [truncateHead("éé\nlast", 3, 1), truncateTail("first\néé\n", 3, 1)]) {
    assert.ok(bounded.bytes <= 3);
    assert.ok(bounded.lines <= 1);
    assert.equal(Buffer.from(bounded.content).toString("utf8"), bounded.content);
  }
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\nb"), 2);
});

test("rejects lexical traversal and sibling-prefix escapes", async () => {
  const { store } = await fixture();
  assert.throws(() => store.resolveRelative("../memory-evil/secret.md"), /escapes the memory bank/);
  assert.throws(() => store.resolveRelative("/tmp/secret.md"), /must be relative/);
  assert.throws(() => store.resolveRelative(""), /non-empty relative path/);
});

test("rejects file and directory symbolic links", async () => {
  const { parent, root, store } = await fixture();
  const outside = join(parent, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "private");
  await symlink(outside, join(root, "linked-dir"));
  await symlink(join(outside, "secret.md"), join(root, "linked-file.md"));

  await assert.rejects(store.readText("linked-dir/secret.md"), /refuses symbolic links/);
  await assert.rejects(store.readText("linked-file.md"), /refuses symbolic links/);
  await assert.rejects(store.replace("linked-dir/new.md", "nope"), /refuses symbolic links/);
  await assert.rejects(store.append("linked-file.md", "nope"), /refuses symbolic links/);
  assert.equal(await readFile(join(outside, "secret.md"), "utf8"), "private");
});

test("replace is atomic and leaves no lock or temporary file", async () => {
  const { root, store } = await fixture();
  await store.replace("nested/state.md", "one\n");
  await store.replace("nested/state.md", "two\n");
  assert.equal(await store.readText("nested/state.md"), "two\n");
  assert.deepEqual(await readdir(join(root, "nested")), ["state.md"]);
});

test("concurrent appends serialize and guarantee newline boundaries", async () => {
  const { store } = await fixture();
  await store.replace("daily.md", "header without newline");
  await Promise.all(Array.from({ length: 40 }, (_, index) => store.append("daily.md", `entry-${index}`)));
  const content = await store.readText("daily.md");
  const lines = content.trimEnd().split("\n");
  assert.equal(lines[0], "header without newline");
  assert.equal(lines.length, 41);
  assert.deepEqual(new Set(lines.slice(1)), new Set(Array.from({ length: 40 }, (_, index) => `entry-${index}`)));
  assert.ok(content.endsWith("\n"));
});

test("exclusive lock serializes appends across processes", async () => {
  const { root, store } = await fixture();
  const storageUrl = new URL("../pi/extensions/storage.ts", import.meta.url).href;
  const configUrl = new URL("../pi/extensions/config.ts", import.meta.url).href;
  const script = `
    const [{ MemoryStore }, { DEFAULT_LIMITS }] = await Promise.all([
      import(${JSON.stringify(storageUrl)}), import(${JSON.stringify(configUrl)})
    ]);
    await new MemoryStore(process.argv[1], DEFAULT_LIMITS).append("daily.md", process.argv[2]);
  `;
  await Promise.all(Array.from({ length: 10 }, (_, index) =>
    execFileAsync(process.execPath, ["--experimental-strip-types", "-e", script, root, `process-${index}`]),
  ));
  const lines = (await store.readText("daily.md")).trimEnd().split("\n");
  assert.equal(lines.length, 10);
  assert.deepEqual(new Set(lines), new Set(Array.from({ length: 10 }, (_, index) => `process-${index}`)));
});

test("an old lock is never reclaimed from age alone", async () => {
  const { root, store } = await fixture({ lockTimeoutMs: 60 });
  await mkdir(root, { recursive: true });
  const lockPath = join(root, ".daily.md.atlas.lock");
  await writeFile(lockPath, "99999 delayed-holder\n");
  await utimes(lockPath, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));

  await assert.rejects(store.append("daily.md", "must not steal"), /Timed out.*remove .* manually/);
  assert.equal(await readFile(lockPath, "utf8"), "99999 delayed-holder\n");
});

test("write and read limits fail with clear errors", async () => {
  const { root, store } = await fixture({
    maxInputBytes: 12,
    maxInputLines: 2,
    maxFileBytes: 20,
    maxFileLines: 3,
    maxReadBytes: 8,
    maxReadLines: 2,
  });
  await assert.rejects(store.replace("large.md", "a".repeat(13)), /update limit is 12 bytes/);
  await assert.rejects(store.replace("lines.md", "a\nb\nc\n"), /update limit is 2 lines/);
  await store.replace("ok.md", "1234567890\n");
  await assert.rejects(store.append("ok.md", "abcdefghij"), /file limit is 20 bytes/);

  await mkdir(root, { recursive: true });
  await writeFile(join(root, "legacy.md"), "1\n2\n3\n4\n");
  await assert.rejects(store.readText("legacy.md"), /safety limit is 3 lines/);

  const bounded = await store.readBounded("ok.md");
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.bytes <= 8);
  assert.ok(bounded.lines <= 2);
});
