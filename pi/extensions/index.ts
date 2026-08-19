import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";

// ─── Paths ──────────────────────────────────────────────────────────
const ATLAS_ROOT =
  process.env.ATLAS_ROOT || join(process.env.HOME || "", ".atlas");
const MEMORY = join(ATLAS_ROOT, "memory");
const KNOWLEDGE = join(MEMORY, "knowledge");
const HISTORY_DAILY = join(MEMORY, "history", "daily");

// ─── Helpers ────────────────────────────────────────────────────────
function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Sandbox a relative path under MEMORY; reject escapes. */
function resolveMemory(rel: string): string {
  const full = resolve(MEMORY, rel);
  if (!full.startsWith(MEMORY)) {
    throw new Error(`Path must be within the atlas memory bank: ${rel}`);
  }
  return full;
}

// ─── Knowledge triggers ─────────────────────────────────────────────
interface TriggerEntry {
  filename: string;
  triggers: string[];
}

function loadKnowledgeTriggers(): TriggerEntry[] {
  const indexPath = join(KNOWLEDGE, "index.csv");
  const content = safeRead(indexPath);
  if (!content) return [];

  const entries: TriggerEntry[] = [];
  // Format: filename,description,"trigger1, trigger2"
  for (const line of content.split("\n").slice(1)) {
    // skip header
    if (!line.trim()) continue;
    const match = line.match(/^([^,]+),(?:[^,]*|"[^"]*"),(?:"([^"]*)"|(.+))$/);
    if (!match) continue;
    const filename = match[1].trim();
    const triggerStr = (match[2] ?? match[3] ?? "").trim();
    const triggers = triggerStr
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    entries.push({ filename, triggers });
  }
  return entries;
}

function checkTriggers(
  text: string,
  entries: TriggerEntry[],
): string[] {
  const lower = text.toLowerCase();
  const matched = new Set<string>();
  for (const entry of entries) {
    for (const trigger of entry.triggers) {
      if (lower.includes(trigger)) {
        matched.add(entry.filename);
        break;
      }
    }
  }
  return [...matched];
}

// ─── Daily context archive ──────────────────────────────────────────
/** If daily.md's date header is stale, archive it and start a fresh stub. */
function archiveIfStale(): void {
  const dailyPath = join(MEMORY, "daily.md");
  const content = safeRead(dailyPath);
  if (!content) return;

  const dateMatch = content.match(/^## Today's Date:\s*(.+)/m);
  const fileDate = dateMatch?.[1]?.trim();
  const today = todayISO();

  // Only archive for a real past date (YYYY-MM-DD). Keep "unknown"/blank as-is.
  if (fileDate && /^\d{4}-\d{2}-\d{2}$/.test(fileDate) && fileDate !== today) {
    mkdirSync(HISTORY_DAILY, { recursive: true });
    const dest = join(HISTORY_DAILY, `${fileDate}.md`);
    // Don't clobber an existing archive for that date; append a suffix.
    let finalDest = dest;
    let n = 2;
    while (existsSync(finalDest)) {
      finalDest = join(HISTORY_DAILY, `${fileDate}-${n}.md`);
      n++;
    }
    renameSync(dailyPath, finalDest);
    writeFileSync(
      dailyPath,
      `## Today's Date: ${today}\n\n**Status**: \n\n### In Progress\n\n### Completed\n\n### Key Decisions\n\n`,
      "utf8",
    );
  }
}

// ─── Extension ──────────────────────────────────────────────────────
export default function atlas(pi: ExtensionAPI) {
  const triggerEntries = loadKnowledgeTriggers();

  // ── Session start: archive stale daily context ──────────────────
  pi.on("session_start", async (_event, _ctx) => {
    try {
      archiveIfStale();
    } catch {
      /* best effort */
    }
  });

  // ── Before agent start: inject memory + triggered knowledge ──────
  pi.on("before_agent_start", async (event, _ctx) => {
    const parts: string[] = [];

    for (const rel of ["projects.md", "daily.md"]) {
      const content = safeRead(join(MEMORY, rel));
      if (content) parts.push(`## Atlas: ${rel}\n\n${content}`);
    }

    // Triggered knowledge from the user's prompt
    if (event.prompt) {
      const hits = checkTriggers(event.prompt, triggerEntries);
      const knowledgeParts: string[] = [];
      for (const filename of hits) {
        const content = safeRead(join(KNOWLEDGE, filename));
        if (content) knowledgeParts.push(`### Knowledge: ${filename}\n\n${content}`);
      }
      if (knowledgeParts.length > 0) {
        parts.push(`## Atlas Triggered Knowledge\n\n${knowledgeParts.join("\n\n")}`);
      }
    }

    if (parts.length === 0) return;

    const header = [
      "# Atlas Memory Bank",
      "",
      "You have a persistent memory bank. Use atlas_read and atlas_update to read and update memory files.",
      "Update daily.md when work is completed, new work starts, or a key decision is made.",
      "Keep daily.md under 150 lines, one line per entry. NEVER overwrite existing entries — use atlas_update with mode \"append\".",
      "",
      ...parts,
    ].join("\n");

    return { systemPrompt: event.systemPrompt + "\n\n" + header };
  });

  // ── Tool: atlas_read ─────────────────────────────────────────────
  pi.registerTool({
    name: "atlas_read",
    label: "Atlas Read",
    description:
      "Read a file from the Atlas memory bank by relative path (e.g. 'daily.md', 'projects.md', 'knowledge/index.csv', 'projects/my-project/README.md').",
    promptSnippet: "Read an Atlas memory bank file by relative path",
    promptGuidelines: [
      "Use atlas_read to access memory bank files: daily.md, projects.md, knowledge docs.",
      "Read daily.md and projects.md at session start if they weren't already injected.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Relative path within memory/ (e.g. 'daily.md')",
      }),
    }),
    async execute(_toolCallId, params) {
      const full = resolveMemory(params.path);
      try {
        const content = await readFile(full, "utf8");
        return {
          content: [{ type: "text", text: content }],
          details: { path: params.path },
        };
      } catch {
        throw new Error(`File not found: ${params.path}`);
      }
    },
  });

  // ── Tool: atlas_update ───────────────────────────────────────────
  pi.registerTool({
    name: "atlas_update",
    label: "Atlas Update",
    description:
      "Update an Atlas memory bank file. mode 'append' adds to the end (use for daily.md log entries); mode 'replace' overwrites fully (read first with atlas_read).",
    promptSnippet: "Append to or replace an Atlas memory bank file",
    promptGuidelines: [
      "Use atlas_update with mode 'append' to add entries to daily.md (Completed, Key Decisions, etc.).",
      "Use mode 'replace' only for full rewrites — always atlas_read first to avoid losing content.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Relative path within memory/" }),
      content: Type.String({ description: "Content to write or append" }),
      mode: Type.Optional(
        Type.Union([Type.Literal("replace"), Type.Literal("append")], {
          description: "Write mode (default: replace)",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const full = resolveMemory(params.path);
      const mode = params.mode || "replace";
      try {
        mkdirSync(dirname(full), { recursive: true });
        if (mode === "append") {
          const existing = safeRead(full) || "";
          await writeFile(full, existing + params.content, "utf8");
        } else {
          await writeFile(full, params.content, "utf8");
        }
        return {
          content: [{ type: "text", text: `Updated ${params.path} (${mode})` }],
          details: { path: params.path, mode },
        };
      } catch (err: any) {
        throw new Error(`Failed to update ${params.path}: ${err.message}`);
      }
    },
  });

  // ── Tool: atlas_search ───────────────────────────────────────────
  pi.registerTool({
    name: "atlas_search",
    label: "Atlas Search",
    description:
      "Search the Atlas knowledge trigger index for reference docs matching keywords. Returns matching knowledge filenames.",
    promptSnippet: "Search Atlas knowledge index by keywords",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords to search for" }),
    }),
    async execute(_toolCallId, params) {
      const hits = checkTriggers(params.query, triggerEntries);
      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: "No matching knowledge files found." }],
          details: { matches: [] },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Found ${hits.length} matching knowledge file(s):\n${hits.map((f) => `- knowledge/${f}`).join("\n")}`,
          },
        ],
        details: { matches: hits },
      };
    },
  });

  // ── Command: /atlas-status ───────────────────────────────────────
  pi.registerCommand("atlas-status", {
    description: "Show Atlas memory bank status (today's date, status, active projects)",
    handler: async (_args, ctx) => {
      const daily = safeRead(join(MEMORY, "daily.md"));
      const projects = safeRead(join(MEMORY, "projects.md"));
      const lines: string[] = ["🗺️ Atlas Status"];

      if (daily) {
        const date = daily.match(/^## Today's Date:\s*(.+)/m)?.[1] ?? "unknown";
        const status = daily.match(/\*\*Status\*\*:\s*(.+)/m)?.[1] ?? "unknown";
        lines.push(`Date: ${date}`);
        lines.push(`Status: ${status}`);
      } else {
        lines.push("daily.md: (not created yet)");
      }

      if (projects) {
        const count = (projects.match(/^- .+/gm) || []).length;
        lines.push(`Active projects: ${count}`);
      }

      // Count knowledge docs
      const index = safeRead(join(KNOWLEDGE, "index.csv"));
      const knowledgeCount = index
        ? index.split("\n").slice(1).filter((l) => l.trim()).length
        : 0;
      lines.push(`Knowledge docs: ${knowledgeCount}`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
