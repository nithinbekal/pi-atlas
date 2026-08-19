import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AtlasLimits } from "./config.ts";
import { MemoryStore, truncateHead, truncateTail, type BoundedText } from "./storage.ts";

export interface WorkstreamConfig {
  name: string;
  aliases?: string[];
}

export interface ProjectConfig {
  name: string;
  aliases?: string[];
  paths?: string[];
  workstreams?: WorkstreamConfig[];
  context?: string[];
}

export interface PrivateAtlasConfig {
  projects?: ProjectConfig[];
}

export interface TriggerEntry {
  filename: string;
  description: string;
  triggers: string[];
}

export interface TriggerMatch {
  filename: string;
  description: string;
  triggers: string[];
}

export interface ProjectMatch {
  project: string;
  workstreams: string[];
  reasons: string[];
  context: string[];
}

export interface ContextSource {
  path: string;
  title: string;
  reason: string;
  content: string;
  truncated: boolean;
}

export interface AtlasContext {
  text: string;
  sources: ContextSource[];
  projectMatches: ProjectMatch[];
  knowledgeMatches: TriggerMatch[];
  truncated: boolean;
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new Error("Atlas knowledge index contains an unterminated quoted field; each CSV record must occupy one physical line (embedded newlines are not supported)");
  }
  fields.push(field.trim());
  return fields;
}

export function parseKnowledgeIndex(content: string): TriggerEntry[] {
  const rows = content.split(/\r?\n/).filter((line) => line.trim());
  if (rows.length === 0) return [];
  const header = parseCsvRow(rows[0]).map((field) => field.toLowerCase());
  const filenameColumn = header.indexOf("filename");
  const triggerColumn = header.indexOf("triggers");
  const descriptionColumn = header.indexOf("description");
  if (filenameColumn < 0 || triggerColumn < 0) {
    throw new Error("Atlas knowledge/index.csv must contain filename and triggers columns");
  }
  return rows.slice(1).map((line, rowIndex) => {
    const fields = parseCsvRow(line);
    const filename = fields[filenameColumn]?.trim();
    if (!filename) throw new Error(`Atlas knowledge index row ${rowIndex + 2} has no filename`);
    const triggers = (fields[triggerColumn] ?? "")
      .split(",")
      .map((trigger) => trigger.trim().toLowerCase())
      .filter(Boolean);
    return {
      filename,
      description: descriptionColumn >= 0 ? fields[descriptionColumn] ?? "" : "",
      triggers,
    };
  });
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function phraseMatches(text: string, phrase: string): boolean {
  const normalized = phrase.trim().toLowerCase();
  if (!normalized) return false;
  const pattern = escapedPattern(normalized).replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function matchTriggers(text: string, entries: TriggerEntry[]): TriggerMatch[] {
  const lower = text.toLowerCase();
  const matches = new Map<string, TriggerMatch>();
  for (const entry of entries) {
    const triggers = entry.triggers.filter((trigger) => phraseMatches(lower, trigger));
    if (triggers.length === 0) continue;
    const prior = matches.get(entry.filename);
    if (prior) {
      prior.triggers = [...new Set([...prior.triggers, ...triggers])];
    } else {
      matches.set(entry.filename, { ...entry, triggers });
    }
  }
  return [...matches.values()];
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

export function parsePrivateConfig(content: string): PrivateAtlasConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error(`Atlas config.json is invalid JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Atlas config.json must be an object");
  const projectsValue = (raw as { projects?: unknown }).projects;
  if (projectsValue === undefined) return {};
  if (!Array.isArray(projectsValue)) throw new Error("Atlas config.json projects must be an array");
  const projects = projectsValue.map((value, index): ProjectConfig => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Atlas config project ${index + 1} must be an object`);
    }
    const project = value as Record<string, unknown>;
    if (typeof project.name !== "string" || !project.name.trim()) {
      throw new Error(`Atlas config project ${index + 1} needs a non-empty name`);
    }
    let workstreams: WorkstreamConfig[] | undefined;
    if (project.workstreams !== undefined) {
      if (!Array.isArray(project.workstreams)) throw new Error(`Atlas project ${project.name} workstreams must be an array`);
      workstreams = project.workstreams.map((workstream, workstreamIndex) => {
        if (!workstream || typeof workstream !== "object" || Array.isArray(workstream)) {
          throw new Error(`Atlas project ${project.name} workstream ${workstreamIndex + 1} must be an object`);
        }
        const item = workstream as Record<string, unknown>;
        if (typeof item.name !== "string" || !item.name.trim()) {
          throw new Error(`Atlas project ${project.name} workstream ${workstreamIndex + 1} needs a name`);
        }
        return { name: item.name, aliases: stringArray(item.aliases, `Atlas workstream ${item.name} aliases`) };
      });
    }
    return {
      name: project.name,
      aliases: stringArray(project.aliases, `Atlas project ${project.name} aliases`),
      paths: stringArray(project.paths, `Atlas project ${project.name} paths`),
      context: stringArray(project.context, `Atlas project ${project.name} context`),
      workstreams,
    };
  });
  return { projects };
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`)) return resolve(homedir(), path.slice(2));
  return path;
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function matchProjects(config: PrivateAtlasConfig, prompt: string, cwd: string): ProjectMatch[] {
  return (config.projects ?? []).flatMap((project) => {
    const reasons: string[] = [];
    const path = (project.paths ?? []).find((candidate) => pathContains(expandHome(candidate), cwd));
    if (path) reasons.push(`cwd is within configured path for ${project.name}`);
    const projectTerms = [project.name, ...(project.aliases ?? [])];
    const promptTerms = projectTerms.filter((term) => phraseMatches(prompt, term));
    if (promptTerms.length > 0) reasons.push(`prompt matched project term(s): ${promptTerms.join(", ")}`);
    const workstreams = (project.workstreams ?? []).flatMap((workstream) => {
      const terms = [workstream.name, ...(workstream.aliases ?? [])].filter((term) => phraseMatches(prompt, term));
      if (terms.length === 0) return [];
      reasons.push(`prompt matched workstream ${workstream.name} via ${terms.join(", ")}`);
      return [workstream.name];
    });
    return reasons.length > 0
      ? [{ project: project.name, workstreams, reasons, context: project.context ?? [] }]
      : [];
  });
}

function dailyWindow(text: string, maxBytes: number, maxLines: number): BoundedText {
  const whole = truncateHead(text, maxBytes, maxLines);
  if (!whole.truncated) return whole;

  const marker = "… [middle of daily.md omitted] …";
  const markerBytes = Buffer.byteLength(`\n${marker}\n`);
  if (maxLines < 3 || maxBytes <= markerBytes) return truncateTail(text, maxBytes, maxLines);

  const headLines = Math.min(20, Math.max(1, Math.floor((maxLines - 1) / 3)));
  const headBytes = Math.max(1, Math.floor((maxBytes - markerBytes) / 3));
  const head = truncateHead(text, headBytes, headLines).content.replace(/\n+$/, "");
  const fixed = `${head}\n${marker}\n`;
  const remainingBytes = Math.max(0, maxBytes - Buffer.byteLength(fixed));
  const remainingLines = Math.max(0, maxLines - fixed.split("\n").length + 1);
  const tail = truncateTail(text, remainingBytes, remainingLines).content.replace(/^\n+/, "");
  const bounded = truncateHead(`${fixed}${tail}`, maxBytes, maxLines);
  return { ...bounded, totalBytes: Buffer.byteLength(text), totalLines: whole.totalLines, truncated: true };
}

function boundedSource(path: string, title: string, reason: string, text: string, limits: AtlasLimits, daily = false): ContextSource {
  const bounded = daily
    ? dailyWindow(text, limits.maxSourceBytes, limits.maxSourceLines)
    : truncateHead(text, limits.maxSourceBytes, limits.maxSourceLines);
  return { path, title, reason, content: bounded.content, truncated: bounded.truncated };
}

async function addIfPresent(
  sources: ContextSource[],
  store: MemoryStore,
  path: string,
  title: string,
  reason: string,
  limits: AtlasLimits,
  daily = false,
): Promise<void> {
  const text = await store.readOptional(path);
  if (text !== null) sources.push(boundedSource(path, title, reason, text, limits, daily));
}

function renderSource(source: ContextSource): string {
  const metadata = [
    `Source: ${source.path}`,
    `Matched because: ${source.reason}`,
    source.truncated ? "Bounded: yes (source was truncated to Atlas context limits)" : "Bounded: no",
  ].join("\n");
  return `## ${source.title}\n\n_${metadata}_\n\n${source.content}`;
}

const CONTEXT_PREAMBLE = [
  "# Atlas Memory Bank",
  "",
  "The following is bounded local context selected by Atlas. Source and match metadata explain why it was included.",
  "Use atlas_read for a specific memory file and atlas_update for durable changes.",
  "Append durable events to daily.md; use /atlas-compact to refresh current.md without deleting raw daily history.",
].join("\n");

export function injectAtlasContext(systemPrompt: string, atlasText: string, limits: AtlasLimits): string {
  const suffix = truncateHead(`\n\n${atlasText}`, limits.maxContextBytes, limits.maxContextLines).content;
  return systemPrompt + suffix;
}

export async function buildAtlasContext(
  store: MemoryStore,
  prompt: string,
  cwd: string,
  limits: AtlasLimits,
): Promise<AtlasContext> {
  const sources: ContextSource[] = [];
  const configText = await store.readOptional("config.json");
  const config = configText === null ? {} : parsePrivateConfig(configText);
  const projectMatches = matchProjects(config, prompt, cwd);
  const projectReason = projectMatches.length > 0
    ? projectMatches.flatMap((match) => match.reasons.map((reason) => `${match.project}: ${reason}`)).join("; ")
    : "backward-compatible global project index";
  await addIfPresent(sources, store, "projects.md", "Atlas Projects", projectReason, limits);

  const current = await store.readOptional("current.md");
  if (current !== null) {
    sources.push(boundedSource("current.md", "Atlas Current State", "generated or maintained current-state summary", current, limits));
  }

  const seenContext = new Set<string>();
  for (const match of projectMatches) {
    for (const path of match.context) {
      if (seenContext.has(path)) continue;
      seenContext.add(path);
      await addIfPresent(
        sources,
        store,
        path,
        `Atlas Project Context: ${match.project}`,
        `${match.project} matched (${match.reasons.join("; ")})`,
        limits,
      );
    }
  }

  const indexText = await store.readOptional("knowledge/index.csv");
  const triggerEntries = indexText === null ? [] : parseKnowledgeIndex(indexText);
  const knowledgeMatches = matchTriggers(prompt, triggerEntries).slice(0, limits.maxKnowledgeMatches);
  for (const match of knowledgeMatches) {
    const path = `knowledge/${match.filename}`;
    await addIfPresent(
      sources,
      store,
      path,
      `Atlas Knowledge: ${match.filename}`,
      `prompt trigger(s): ${match.triggers.join(", ")}`,
      limits,
    );
  }

  if (current !== null) {
    await addIfPresent(sources, store, "daily.md", "Atlas Recent Daily Context", "recent raw entries supplement current.md", limits, true);
  } else {
    await addIfPresent(sources, store, "daily.md", "Atlas Daily Context", "current.md is absent; using a bounded head-and-tail window", limits, true);
  }

  const preamble = truncateHead(CONTEXT_PREAMBLE, limits.maxContextBytes, limits.maxContextLines);
  if (sources.length === 0) {
    return { text: "", sources: [], projectMatches, knowledgeMatches, truncated: false };
  }

  const rendered: string[] = preamble.content ? [preamble.content] : [];
  let usedBytes = preamble.bytes;
  let usedLines = preamble.lines;
  let totalTruncated = preamble.truncated;
  const includedSources: ContextSource[] = [];
  // Keep room for an explicit omission notice if a source does not fit.
  const footerReserveBytes = Math.min(200, Math.floor(limits.maxContextBytes / 4));
  const footerReserveLines = Math.min(2, Math.floor(limits.maxContextLines / 4));
  const contentBudgetBytes = Math.max(0, limits.maxContextBytes - footerReserveBytes);
  const contentBudgetLines = Math.max(0, limits.maxContextLines - footerReserveLines);
  if (!preamble.truncated) for (const source of sources) {
    const separator = rendered.length > 0 ? "\n\n" : "";
    const candidate = renderSource(source);
    const remainingBytes = contentBudgetBytes - usedBytes - Buffer.byteLength(separator);
    const remainingLines = contentBudgetLines - usedLines - (separator ? 2 : 0);
    if (remainingBytes <= 0 || remainingLines <= 0) {
      totalTruncated = true;
      break;
    }
    const bounded = truncateHead(candidate, remainingBytes, remainingLines);
    if (!bounded.content) {
      totalTruncated = true;
      break;
    }
    rendered.push(bounded.content);
    includedSources.push({ ...source, truncated: source.truncated || bounded.truncated });
    usedBytes += Buffer.byteLength(separator) + bounded.bytes;
    usedLines += (separator ? 2 : 0) + bounded.lines;
    if (bounded.truncated) {
      totalTruncated = true;
      break;
    }
  }

  const omitted = sources.length - includedSources.length;
  if (omitted > 0) totalTruncated = true;
  const footer = totalTruncated
    ? `\n\n_Atlas context budget reached; ${omitted} source(s) omitted. Use atlas_read for a specific file._`
    : "";
  const final = truncateHead(rendered.join("\n\n") + footer, limits.maxContextBytes, limits.maxContextLines);
  return {
    text: final.content,
    sources: includedSources,
    projectMatches,
    knowledgeMatches,
    truncated: totalTruncated,
  };
}
