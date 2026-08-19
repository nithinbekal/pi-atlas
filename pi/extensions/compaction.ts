import { randomBytes } from "node:crypto";
import type { AtlasLimits } from "./config.ts";
import { MemoryStore, truncateHead, truncateTail } from "./storage.ts";

export interface CompactionResult {
  snapshotPath: string;
  currentPath: string;
  sourceBytes: number;
  currentBytes: number;
  sections: string[];
}

const DEFAULT_CURRENT_SECTIONS = ["in progress", "key decisions", "blockers", "next steps"];

function sectionKey(value: string): string {
  return value.trim().replace(/[*_`:#]+/g, "").trim().toLowerCase();
}

interface MarkdownSection {
  heading: string;
  lines: string[];
}

function parseSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection = { heading: "", lines: [] };
  sections.push(current);
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (heading) {
      current = { heading: heading[1], lines: [] };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }
  return sections;
}

function meaningfulLines(lines: string[]): string[] {
  return lines.filter((line) => line.trim());
}

export function buildCurrentState(
  daily: string,
  limits: Pick<
    AtlasLimits,
    "compactSectionLines" | "compactRecentLines" | "maxInputBytes" | "maxInputLines" | "maxFileBytes" | "maxFileLines"
  >,
  generatedAt = new Date(),
): { content: string; sections: string[] } {
  const parsed = parseSections(daily);
  const sections: string[] = [];
  const output: string[] = [
    "# Atlas Current State",
    "",
    `Generated from daily.md at ${generatedAt.toISOString()}. Raw daily history was not modified.`,
  ];

  const date = daily.match(/^## Today's Date:\s*(.+)$/m)?.[1]?.trim();
  const status = daily.match(/^\*\*Status\*\*:\s*(.*)$/m)?.[1]?.trim();
  if (date) output.push("", `**Daily date**: ${date}`);
  if (status) output.push(`**Status**: ${status}`);

  for (const section of parsed) {
    if (!DEFAULT_CURRENT_SECTIONS.includes(sectionKey(section.heading))) continue;
    const sectionLimit = Math.min(limits.compactSectionLines, limits.maxInputLines, limits.maxFileLines);
    const lines = meaningfulLines(section.lines).slice(-sectionLimit);
    if (lines.length === 0) continue;
    sections.push(section.heading);
    output.push("", `## ${section.heading}`, "", ...lines);
  }

  if (sections.length === 0) {
    const recentLimit = Math.min(limits.compactRecentLines, limits.maxInputLines, limits.maxFileLines);
    const recent = truncateTail(daily, Math.min(limits.maxInputBytes, limits.maxFileBytes), recentLimit).content.trim();
    if (recent) {
      sections.push("Recent context");
      output.push("", "## Recent context", "", recent);
    }
  }

  const bounded = truncateHead(
    `${output.join("\n").trimEnd()}\n`,
    Math.min(limits.maxInputBytes, limits.maxFileBytes),
    Math.min(limits.maxInputLines, limits.maxFileLines),
  ).content;
  const includedSections = sections.filter((section) => bounded.includes(`## ${section}`));
  return { content: bounded, sections: includedSections };
}

function snapshotName(now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `history/daily/snapshots/${timestamp}-${randomBytes(4).toString("hex")}.md`;
}

export async function compactDaily(
  store: MemoryStore,
  limits: AtlasLimits,
  now = new Date(),
): Promise<CompactionResult> {
  const daily = await store.readText("daily.md");
  const current = buildCurrentState(daily, limits, now);
  const snapshotPath = snapshotName(now);
  await store.replace(snapshotPath, daily);
  await store.replace("current.md", current.content);
  return {
    snapshotPath,
    currentPath: "current.md",
    sourceBytes: Buffer.byteLength(daily),
    currentBytes: Buffer.byteLength(current.content),
    sections: current.sections,
  };
}

function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function archiveStaleDaily(store: MemoryStore, now = new Date()): Promise<string | null> {
  const today = todayIso(now);
  let archivePath: string | null = null;
  await store.updateAtomic("daily.md", async (daily) => {
    if (daily === null) return undefined;
    const fileDate = daily.match(/^## Today's Date:\s*(.+)$/m)?.[1]?.trim();
    if (!fileDate || !/^\d{4}-\d{2}-\d{2}$/.test(fileDate) || fileDate >= today) return undefined;

    const suffix = randomBytes(4).toString("hex");
    archivePath = `history/daily/${fileDate}-${suffix}.md`;
    // The daily.md lock remains held until its exact contents are synced to the
    // archive and the fresh stub is atomically installed, so a cooperating
    // append cannot be lost.
    await store.replace(archivePath, daily);
    return `## Today's Date: ${today}\n\n**Status**: \n\n### In Progress\n\n### Completed\n\n### Key Decisions\n\n`;
  });
  return archivePath;
}
