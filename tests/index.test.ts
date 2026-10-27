import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import atlas, { renderAtlasRead, renderSearchResults } from "../pi/extensions/index.ts";
import { lineCount, MemoryStore } from "../pi/extensions/storage.ts";
import { DEFAULT_LIMITS } from "../pi/extensions/config.ts";

const OUTPUT_LIMITS = { maxReadBytes: 120, maxReadLines: 3 };

type BeforeAgentStart = ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;

/** Load the extension against a temp ATLAS_ROOT and capture its before_agent_start handler. */
function loadAtlas(atlasRoot: string): BeforeAgentStart {
  const handlers = new Map<string, unknown>();
  const previousRoot = process.env.ATLAS_ROOT;
  process.env.ATLAS_ROOT = atlasRoot;
  try {
    atlas({
      on: (event: string, handler: unknown) => {
        handlers.set(event, handler);
        return () => {};
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI);
  } finally {
    if (previousRoot === undefined) delete process.env.ATLAS_ROOT;
    else process.env.ATLAS_ROOT = previousRoot;
  }
  const handler = handlers.get("before_agent_start");
  assert.ok(handler, "extension registers before_agent_start");
  return handler as BeforeAgentStart;
}

function startEvent(start: { messageType: "user"; prompt: string } | { messageType: "custom" }): BeforeAgentStartEvent {
  const base = { type: "before_agent_start", systemPrompt: "base prompt", systemPromptOptions: { cwd: "/tmp", sections: {} } };
  const event = start.messageType === "user"
    ? { ...base, messageType: "user", prompt: start.prompt }
    : { ...base, messageType: "custom", message: { role: "custom", customType: "test", content: "go", timestamp: 0 } };
  return event as unknown as BeforeAgentStartEvent;
}

test("before_agent_start sets a stable atlas_memory section instead of forcing the system prompt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "atlas-index-"));
  const store = new MemoryStore(join(parent, "memory"), DEFAULT_LIMITS);
  await store.replace("projects.md", "# Projects\n\n- Example Project\n");
  const handler = loadAtlas(parent);
  const notices: string[] = [];
  const ctx = { cwd: parent, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;

  const userRun = startEvent({ messageType: "user", prompt: "hello" });
  assert.equal(await handler(userRun, ctx), undefined, "handler returns no systemPrompt override");
  const section = userRun.systemPromptOptions.sections.atlas_memory;
  assert.match(section, /^# Atlas Memory Bank/);
  assert.match(section, /- Example Project/);
  assert.deepEqual(notices, []);

  const customRun = startEvent({ messageType: "custom" });
  assert.equal(await handler(customRun, ctx), undefined);
  assert.equal(customRun.systemPromptOptions.sections.atlas_memory, section, "custom runs keep the same section");

  const outside = join(parent, "outside.md");
  await writeFile(outside, "outside the memory bank\n");
  await rm(join(parent, "memory", "projects.md"));
  await symlink(outside, join(parent, "memory", "projects.md"));
  const failingRun = startEvent({ messageType: "user", prompt: "hello again" });
  assert.equal(await handler(failingRun, ctx), undefined);
  assert.equal(failingRun.systemPromptOptions.sections.atlas_memory, section, "a failed build keeps the previous section");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Atlas context was not loaded: .*symbolic links/);
});

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
