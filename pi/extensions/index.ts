import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { archiveStaleDaily, compactDaily } from "./compaction.ts";
import { atlasMemoryRoot, loadLimits } from "./config.ts";
import {
  buildAtlasContext,
  injectAtlasContext,
  matchProjects,
  matchTriggers,
  parseKnowledgeIndex,
  parsePrivateConfig,
  type TriggerMatch,
} from "./retrieval.ts";
import { lineCount, MemoryStore, renderBoundedOutput, truncateHead, type BoundedText } from "./storage.ts";

export function renderAtlasRead(result: BoundedText, limits: { maxReadBytes: number; maxReadLines: number }): string {
  const notice = result.truncated
    ? `[Atlas read output truncated; source has ${result.totalLines} lines and ${result.totalBytes} bytes.]`
    : undefined;
  return renderBoundedOutput(result.content, limits.maxReadBytes, limits.maxReadLines, notice);
}

export function renderSearchResults(
  matches: TriggerMatch[],
  limits: { maxReadBytes: number; maxReadLines: number },
): string {
  if (matches.length === 0) {
    return truncateHead("No matching knowledge files found.", limits.maxReadBytes, limits.maxReadLines).content;
  }
  const rows = matches.map((match) =>
    `- knowledge/${match.filename} (matched: ${match.triggers.join(", ")}${match.description ? `; ${match.description}` : ""})`,
  ).join("\n");
  const full = `Found ${matches.length} matching knowledge file(s):\n${rows}`;
  const bounded = truncateHead(full, limits.maxReadBytes, limits.maxReadLines);
  return bounded.truncated
    ? renderBoundedOutput(full, limits.maxReadBytes, limits.maxReadLines, "[Atlas search output truncated to configured read limits.]")
    : bounded.content;
}

export default function atlas(pi: ExtensionAPI) {
  const limits = loadLimits();
  const store = new MemoryStore(atlasMemoryRoot(), limits);
  let lastWarning: string | undefined;

  const warnOnce = (message: string, notify: (message: string, level: "warning") => void): void => {
    if (message === lastWarning) return;
    lastWarning = message;
    notify(message, "warning");
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      const archived = await archiveStaleDaily(store);
      if (archived) ctx.ui.notify(`Atlas archived stale daily context to ${archived}`, "info");
    } catch (error) {
      warnOnce(`Atlas could not archive daily.md: ${(error as Error).message}`, ctx.ui.notify.bind(ctx.ui));
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const context = await buildAtlasContext(store, event.prompt ?? "", ctx.cwd, limits);
      if (!context.text) return;
      lastWarning = undefined;
      return { systemPrompt: injectAtlasContext(event.systemPrompt, context.text, limits) };
    } catch (error) {
      warnOnce(`Atlas context was not loaded: ${(error as Error).message}`, ctx.ui.notify.bind(ctx.ui));
      return;
    }
  });

  pi.registerTool({
    name: "atlas_read",
    label: "Atlas Read",
    description: `Read a memory-bank file by relative path. Output is bounded to ${limits.maxReadLines} lines or ${limits.maxReadBytes} bytes. Paths that escape memory/, including symbolic-link escapes, are rejected.`,
    promptSnippet: "Read a bounded Atlas memory-bank file by relative path",
    promptGuidelines: [
      "Use atlas_read for specific Atlas files when injected context is insufficient.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Relative path within memory/ (for example daily.md or knowledge/index.csv)" }),
    }),
    async execute(_toolCallId, params) {
      const result = await store.readBounded(params.path);
      const text = renderAtlasRead(result, limits);
      return {
        content: [{ type: "text", text }],
        details: {
          path: params.path,
          ...result,
          outputBytes: Buffer.byteLength(text),
          outputLines: lineCount(text),
        },
      };
    },
  });

  pi.registerTool({
    name: "atlas_update",
    label: "Atlas Update",
    description: `Atomically replace or lock-safely append to an Atlas file. Appends serialize, preserve entry boundaries, and end in a newline. Input is limited to ${limits.maxInputLines} lines/${limits.maxInputBytes} bytes; final files to ${limits.maxFileLines} lines/${limits.maxFileBytes} bytes.`,
    promptSnippet: "Atomically append to or replace an Atlas memory-bank file",
    promptGuidelines: [
      "Use atlas_update with mode 'append' for durable daily.md events.",
      "Use atlas_update mode 'replace' only after atlas_read; replacement is atomic but intentionally replaces the full file.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Relative path within memory/" }),
      content: Type.String({ description: "Content to append or atomically replace" }),
      mode: Type.Optional(StringEnum(["replace", "append"] as const, { description: "Write mode (default: replace)" })),
    }),
    async execute(_toolCallId, params) {
      const mode = params.mode ?? "replace";
      if (mode === "append") await store.append(params.path, params.content);
      else await store.replace(params.path, params.content);
      return {
        content: [{ type: "text", text: `Updated ${params.path} (${mode})` }],
        details: { path: params.path, mode, bytes: Buffer.byteLength(params.content, "utf8") },
      };
    },
  });

  pi.registerTool({
    name: "atlas_search",
    label: "Atlas Search",
    description: `Search knowledge/index.csv with segment-aware trigger matching. Returns at most ${limits.maxKnowledgeMatches} matches and explains which triggers matched.`,
    promptSnippet: "Search Atlas knowledge triggers with bounded results",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords or phrase to match against knowledge triggers" }),
    }),
    async execute(_toolCallId, params) {
      const index = await store.readOptional("knowledge/index.csv");
      const matches = index === null
        ? []
        : matchTriggers(params.query, parseKnowledgeIndex(index)).slice(0, limits.maxKnowledgeMatches);
      const text = renderSearchResults(matches, limits);
      return {
        content: [{ type: "text", text }],
        details: {
          matches,
          outputBytes: Buffer.byteLength(text),
          outputLines: lineCount(text),
        },
      };
    },
  });

  pi.registerCommand("atlas-status", {
    description: "Show bounded Atlas status, project matching, and configured safety limits",
    handler: async (_args, ctx) => {
      try {
        const daily = await store.readOptional("daily.md");
        const projects = await store.readOptional("projects.md");
        const configText = await store.readOptional("config.json");
        const config = configText === null ? {} : parsePrivateConfig(configText);
        const index = await store.readOptional("knowledge/index.csv");
        const cwdMatches = matchProjects(config, "", ctx.cwd);
        const lines = [
          "🗺️ Atlas Status",
          `Memory root: ${store.root}`,
          `Daily date: ${daily?.match(/^## Today's Date:\s*(.+)/m)?.[1] ?? "not created"}`,
          `Daily status: ${daily?.match(/^\*\*Status\*\*:\s*(.+)/m)?.[1] ?? "unknown"}`,
          `Project index entries: ${(projects?.match(/^- .+/gm) ?? []).length}`,
          `Private project aliases configured: ${config.projects?.length ?? 0}`,
          `Projects matching cwd: ${cwdMatches.map((match) => match.project).join(", ") || "none"}`,
          `Knowledge docs indexed: ${index === null ? 0 : parseKnowledgeIndex(index).length}`,
          `Context budget: ${limits.maxContextLines} lines / ${limits.maxContextBytes} bytes`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        ctx.ui.notify(`Atlas status failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("atlas-compact", {
    description: "Snapshot daily.md and refresh bounded current.md without changing raw daily history",
    handler: async (_args, ctx) => {
      try {
        const result = await compactDaily(store, limits);
        ctx.ui.notify(
          `Atlas current state refreshed (${result.currentBytes} bytes, sections: ${result.sections.join(", ") || "recent context"}).\nRaw snapshot: ${result.snapshotPath}\ndaily.md was not modified.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Atlas compaction failed: ${(error as Error).message}`, "error");
      }
    },
  });
}
