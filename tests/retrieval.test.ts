import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_LIMITS } from "../pi/extensions/config.ts";
import {
  buildAtlasContext,
  injectAtlasContext,
  matchProjects,
  matchTriggers,
  parseKnowledgeIndex,
  phraseMatches,
} from "../pi/extensions/retrieval.ts";
import { lineCount, MemoryStore } from "../pi/extensions/storage.ts";

test("CSV parser handles quoted descriptions and trigger lists", () => {
  const entries = parseKnowledgeIndex([
    "filename,description,triggers",
    'alpha.md,"A ""quoted"" reference, with comma","atlas, memory bank"',
  ].join("\n"));
  assert.deepEqual(entries, [{
    filename: "alpha.md",
    description: 'A "quoted" reference, with comma',
    triggers: ["atlas", "memory bank"],
  }]);
});

test("knowledge CSV deliberately rejects multiline records", () => {
  assert.throws(
    () => parseKnowledgeIndex('filename,description,triggers\nalpha.md,"line one\nline two","atlas"\n'),
    /each CSV record must occupy one physical line/,
  );
});

test("trigger matching is case-insensitive and segment-aware", () => {
  const entries = [{ filename: "pi.md", description: "", triggers: ["pi", "memory bank"] }];
  assert.equal(phraseMatches("Use PI now", "pi"), true);
  assert.equal(phraseMatches("spinning", "pi"), false);
  assert.deepEqual(matchTriggers("Check the Memory Bank", entries)[0].triggers, ["memory bank"]);
});

test("project matching supports private aliases, workstreams, and path boundaries", () => {
  const config = {
    projects: [{
      name: "Example Project",
      aliases: ["example-app"],
      paths: ["/workspace/example"],
      context: ["projects/example.md"],
      workstreams: [{ name: "API", aliases: ["backend lane"] }],
    }],
  };
  const byPath = matchProjects(config, "unrelated", "/workspace/example/packages/core");
  assert.equal(byPath[0].project, "Example Project");
  assert.match(byPath[0].reasons[0], /cwd/);
  assert.deepEqual(matchProjects(config, "unrelated", "/workspace/example-other"), []);

  const byAlias = matchProjects(config, "Continue example-app on the backend lane", "/tmp");
  assert.deepEqual(byAlias[0].workstreams, ["API"]);
  assert.match(byAlias[0].reasons.join(" "), /example-app/);
});

test("retrieval remains layout-compatible, bounded, and reports provenance", async () => {
  const parent = await mkdtemp(join(tmpdir(), "atlas-retrieval-"));
  const limits = {
    ...DEFAULT_LIMITS,
    maxContextBytes: 2_000,
    maxContextLines: 40,
    maxSourceBytes: 700,
    maxSourceLines: 15,
    maxKnowledgeMatches: 1,
  };
  const store = new MemoryStore(join(parent, "memory"), limits);
  await store.replace("projects.md", "# Projects\n\n- Example Project\n");
  await store.replace("daily.md", `## Today's Date: 2026-01-01\n\n${Array.from({ length: 60 }, (_, index) => `event ${index}`).join("\n")}\n`);
  await store.replace("config.json", JSON.stringify({
    projects: [{ name: "Example Project", aliases: ["example-app"], paths: ["/workspace/example"], context: ["projects/example.md"] }],
  }));
  await store.replace("projects/example.md", "private project context\n");
  await store.replace("knowledge/index.csv", 'filename,description,triggers\nreference.md,Generic reference,"special trigger"\nother.md,Other,"special trigger"\n');
  await store.replace("knowledge/reference.md", `${"knowledge ".repeat(300)}\n`);
  await store.replace("knowledge/other.md", "must be omitted by match limit\n");

  const context = await buildAtlasContext(store, "Use example-app and special trigger", "/workspace/example/src", limits);
  assert.match(context.text, /Source: projects\.md/);
  assert.match(context.text, /Matched because:/);
  assert.match(context.text, /private project context/);
  assert.equal(context.knowledgeMatches.length, 1);
  assert.equal(context.knowledgeMatches[0].filename, "reference.md");
  assert.ok(Buffer.byteLength(context.text) <= limits.maxContextBytes, "rendered context including its preamble is byte bounded");
  assert.ok(lineCount(context.text) <= limits.maxContextLines, "rendered context including its preamble is line bounded");
  const base = "existing system prompt";
  const injected = injectAtlasContext(base, context.text, limits).slice(base.length);
  assert.ok(Buffer.byteLength(injected) <= limits.maxContextBytes, "actual injected suffix includes separator overhead in its byte bound");
  assert.ok(lineCount(injected) <= limits.maxContextLines, "actual injected suffix includes separator overhead in its line bound");
  assert.equal(context.sources.some((source) => source.path === "daily.md" && source.truncated), true);
  for (const source of context.sources) {
    assert.ok(Buffer.byteLength(source.content) <= limits.maxSourceBytes);
    assert.ok(lineCount(source.content) <= limits.maxSourceLines);
  }
});

test("daily head-and-tail rendering has no byte or line off-by-one", async () => {
  const parent = await mkdtemp(join(tmpdir(), "atlas-retrieval-daily-bounds-"));
  const limits = {
    ...DEFAULT_LIMITS,
    maxSourceBytes: 80,
    maxSourceLines: 4,
  };
  const store = new MemoryStore(join(parent, "memory"), limits);
  await store.replace("daily.md", `${Array.from({ length: 20 }, (_, index) => `daily-${index}`).join("\n")}\n`);

  const context = await buildAtlasContext(store, "anything", parent, limits);
  const daily = context.sources.find((source) => source.path === "daily.md");
  assert.ok(daily);
  assert.match(daily.content, /middle of daily\.md omitted/);
  assert.match(daily.content, /daily-19/);
  assert.ok(Buffer.byteLength(daily.content) <= limits.maxSourceBytes);
  assert.ok(lineCount(daily.content) <= limits.maxSourceLines);
});

test("an empty memory bank injects no wrapper-only context", async () => {
  const parent = await mkdtemp(join(tmpdir(), "atlas-retrieval-empty-"));
  const store = new MemoryStore(join(parent, "memory"), DEFAULT_LIMITS);
  const context = await buildAtlasContext(store, "anything", parent, DEFAULT_LIMITS);
  assert.equal(context.text, "");
});

test("unsafe knowledge filenames fail closed instead of escaping memory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "atlas-retrieval-escape-"));
  const store = new MemoryStore(join(parent, "memory"), DEFAULT_LIMITS);
  await store.replace("knowledge/index.csv", 'filename,description,triggers\n../../outside.md,Bad,"escape me"\n');
  await assert.rejects(
    buildAtlasContext(store, "escape me", parent, DEFAULT_LIMITS),
    /escapes the memory bank/,
  );
});
