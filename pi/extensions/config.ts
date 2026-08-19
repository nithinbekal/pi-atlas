import { homedir } from "node:os";
import { join } from "node:path";

export interface AtlasLimits {
  maxPathLength: number;
  maxInputBytes: number;
  maxInputLines: number;
  maxFileBytes: number;
  maxFileLines: number;
  maxReadBytes: number;
  maxReadLines: number;
  maxContextBytes: number;
  maxContextLines: number;
  maxSourceBytes: number;
  maxSourceLines: number;
  maxKnowledgeMatches: number;
  lockTimeoutMs: number;
  compactSectionLines: number;
  compactRecentLines: number;
}

export const DEFAULT_LIMITS: AtlasLimits = {
  maxPathLength: 1024,
  maxInputBytes: 256 * 1024,
  maxInputLines: 4_000,
  maxFileBytes: 1024 * 1024,
  maxFileLines: 20_000,
  maxReadBytes: 50 * 1024,
  maxReadLines: 2_000,
  maxContextBytes: 24 * 1024,
  maxContextLines: 400,
  maxSourceBytes: 8 * 1024,
  maxSourceLines: 120,
  maxKnowledgeMatches: 3,
  lockTimeoutMs: 5_000,
  compactSectionLines: 20,
  compactRecentLines: 40,
};

const ENV_LIMITS: Record<keyof AtlasLimits, string> = {
  maxPathLength: "ATLAS_MAX_PATH_LENGTH",
  maxInputBytes: "ATLAS_MAX_INPUT_BYTES",
  maxInputLines: "ATLAS_MAX_INPUT_LINES",
  maxFileBytes: "ATLAS_MAX_FILE_BYTES",
  maxFileLines: "ATLAS_MAX_FILE_LINES",
  maxReadBytes: "ATLAS_MAX_READ_BYTES",
  maxReadLines: "ATLAS_MAX_READ_LINES",
  maxContextBytes: "ATLAS_MAX_CONTEXT_BYTES",
  maxContextLines: "ATLAS_MAX_CONTEXT_LINES",
  maxSourceBytes: "ATLAS_MAX_SOURCE_BYTES",
  maxSourceLines: "ATLAS_MAX_SOURCE_LINES",
  maxKnowledgeMatches: "ATLAS_MAX_KNOWLEDGE_MATCHES",
  lockTimeoutMs: "ATLAS_LOCK_TIMEOUT_MS",
  compactSectionLines: "ATLAS_COMPACT_SECTION_LINES",
  compactRecentLines: "ATLAS_COMPACT_RECENT_LINES",
};

export function loadLimits(env: NodeJS.ProcessEnv = process.env): AtlasLimits {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(ENV_LIMITS) as Array<keyof AtlasLimits>) {
    const name = ENV_LIMITS[key];
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
      throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
    }
    limits[key] = Number(raw);
  }

  if (limits.maxInputBytes > limits.maxFileBytes || limits.maxInputLines > limits.maxFileLines) {
    throw new Error("Atlas update limits cannot exceed the corresponding file safety limits");
  }
  if (limits.maxReadBytes > limits.maxFileBytes || limits.maxReadLines > limits.maxFileLines) {
    throw new Error("Atlas read limits cannot exceed the corresponding file safety limits");
  }
  if (limits.maxSourceBytes > limits.maxContextBytes || limits.maxSourceLines > limits.maxContextLines) {
    throw new Error("Atlas per-source context limits cannot exceed total context limits");
  }
  if (limits.compactSectionLines > limits.maxInputLines || limits.compactRecentLines > limits.maxInputLines) {
    throw new Error("Atlas compaction line settings cannot exceed the update line limit");
  }
  return limits;
}

export function atlasMemoryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const atlasRoot = env.ATLAS_ROOT || join(env.HOME || homedir(), ".atlas");
  return join(atlasRoot, "memory");
}
