import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { AtlasLimits } from "./config.ts";

export interface BoundedText {
  content: string;
  bytes: number;
  lines: number;
  totalBytes: number;
  totalLines: number;
  truncated: boolean;
}

const mutationQueues = new Map<string, Promise<void>>();

export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const newlines = text.match(/\n/g)?.length ?? 0;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function fitUtf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
}

function fitUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/^\uFFFD+/, "");
}

export function truncateHead(text: string, maxBytes: number, maxLines: number): BoundedText {
  const totalBytes = byteLength(text);
  const totalLines = lineCount(text);
  let end = text.length;
  if (maxLines <= 0 || maxBytes <= 0) {
    end = 0;
  } else if (totalLines > maxLines) {
    let newlines = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === "\n" && ++newlines === maxLines) {
        end = index + 1;
        break;
      }
    }
  }
  const content = fitUtf8Head(text.slice(0, end), maxBytes);
  const bytes = byteLength(content);
  const lines = lineCount(content);
  return { content, bytes, lines, totalBytes, totalLines, truncated: bytes < totalBytes || lines < totalLines };
}

export function truncateTail(text: string, maxBytes: number, maxLines: number): BoundedText {
  const totalBytes = byteLength(text);
  const totalLines = lineCount(text);
  let start = 0;
  if (maxLines <= 0 || maxBytes <= 0) {
    start = text.length;
  } else if (totalLines > maxLines) {
    const linesToSkip = totalLines - maxLines;
    let newlines = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === "\n" && ++newlines === linesToSkip) {
        start = index + 1;
        break;
      }
    }
  }
  const content = fitUtf8Tail(text.slice(start), maxBytes);
  const bytes = byteLength(content);
  const lines = lineCount(content);
  return { content, bytes, lines, totalBytes, totalLines, truncated: bytes < totalBytes || lines < totalLines };
}

export function renderBoundedOutput(
  content: string,
  maxBytes: number,
  maxLines: number,
  truncationNotice?: string,
): string {
  if (!truncationNotice) return truncateHead(content, maxBytes, maxLines).content;
  const notice = truncateHead(truncationNotice, maxBytes, maxLines).content.replace(/\n+$/, "");
  if (notice !== truncationNotice) return notice;
  const body = truncateHead(
    content,
    Math.max(0, maxBytes - byteLength(`\n\n${notice}`)),
    Math.max(0, maxLines - lineCount(notice) - 1),
  ).content.replace(/\n+$/, "");
  return truncateHead(`${body}${body ? "\n\n" : ""}${notice}`, maxBytes, maxLines).content;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class MemoryStore {
  readonly root: string;
  readonly limits: AtlasLimits;

  constructor(root: string, limits: AtlasLimits) {
    this.root = resolve(root);
    this.limits = limits;
  }

  resolveRelative(rawPath: string): string {
    const relPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
    if (!relPath || relPath.includes("\0")) throw new Error("Atlas path must be a non-empty relative path");
    if (relPath.length > this.limits.maxPathLength) {
      throw new Error(`Atlas path exceeds ${this.limits.maxPathLength} characters`);
    }
    if (isAbsolute(relPath)) throw new Error(`Atlas path must be relative: ${rawPath}`);
    const fullPath = resolve(this.root, relPath);
    if (!isContained(this.root, fullPath)) {
      throw new Error(`Atlas path escapes the memory bank: ${rawPath}`);
    }
    return fullPath;
  }

  private async ensureRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory()) throw new Error(`Atlas memory root is not a directory: ${this.root}`);
    return realpath(this.root);
  }

  private async assertSafeExistingPath(fullPath: string, allowMissing: boolean): Promise<void> {
    const canonicalRoot = await this.ensureRoot();
    const rel = relative(this.root, fullPath);
    const segments = rel === "" ? [] : rel.split(sep);
    let current = this.root;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new Error(`Atlas refuses symbolic links in memory paths: ${relative(this.root, current)}`);
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT" && allowMissing) return;
        throw error;
      }
    }
    try {
      const canonicalTarget = await realpath(fullPath);
      if (!isContained(canonicalRoot, canonicalTarget)) {
        throw new Error(`Atlas path resolves outside the memory bank: ${relative(this.root, fullPath)}`);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || !allowMissing) throw error;
    }
  }

  private async ensureSafeParent(fullPath: string): Promise<void> {
    await this.ensureRoot();
    const parent = dirname(fullPath);
    const rel = relative(this.root, parent);
    let current = this.root;
    for (const segment of rel === "" ? [] : rel.split(sep)) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new Error(`Atlas refuses symbolic links in memory paths: ${relative(this.root, current)}`);
        }
        if (!info.isDirectory()) throw new Error(`Atlas path parent is not a directory: ${relative(this.root, current)}`);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        await mkdir(current, { mode: 0o700 });
      }
    }
    await this.assertSafeExistingPath(parent, false);
  }

  private async openVerifiedParent(fullPath: string): Promise<FileHandle> {
    const parent = dirname(fullPath);
    await this.assertSafeExistingPath(parent, false);
    const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await this.verifyParentHandle(fullPath, handle);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async verifyParentHandle(fullPath: string, handle: FileHandle): Promise<void> {
    const parent = dirname(fullPath);
    const [held, current, canonicalRoot, canonicalParent] = await Promise.all([
      handle.stat(),
      lstat(parent),
      this.ensureRoot(),
      realpath(parent),
    ]);
    if (!held.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
      || held.dev !== current.dev || held.ino !== current.ino || !isContained(canonicalRoot, canonicalParent)) {
      throw new Error(`Atlas path parent changed during access: ${relative(this.root, parent) || "."}`);
    }
  }

  private async verifyOpenedPath(fullPath: string, handle: FileHandle): Promise<void> {
    const [held, current] = await Promise.all([handle.stat(), lstat(fullPath)]);
    if (!held.isFile() || current.isSymbolicLink() || !current.isFile()
      || held.dev !== current.dev || held.ino !== current.ino) {
      throw new Error(`Atlas path changed during access: ${relative(this.root, fullPath)}`);
    }
  }

  private async syncDirectory(handle: FileHandle): Promise<void> {
    try {
      await handle.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF"].includes(errorCode(error) ?? "")) throw error;
    }
  }

  async exists(relPath: string): Promise<boolean> {
    const fullPath = this.resolveRelative(relPath);
    try {
      await this.assertSafeExistingPath(fullPath, false);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async readText(relPath: string): Promise<string> {
    const fullPath = this.resolveRelative(relPath);
    await this.assertSafeExistingPath(fullPath, false);
    const parentHandle = await this.openVerifiedParent(fullPath);
    let handle: FileHandle | undefined;
    try {
      // O_NOFOLLOW protects the final component. Parent identity checks detect
      // ordinary rename/symlink swaps around the open on Node's path-based API.
      handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      await this.verifyOpenedPath(fullPath, handle);
      await this.verifyParentHandle(fullPath, parentHandle);
      const info = await handle.stat();
      if (info.size > this.limits.maxFileBytes) {
        throw new Error(`Atlas file ${relPath} is ${info.size} bytes; safety limit is ${this.limits.maxFileBytes} bytes`);
      }
      const text = await handle.readFile("utf8");
      await this.verifyParentHandle(fullPath, parentHandle);
      const lines = lineCount(text);
      if (lines > this.limits.maxFileLines) {
        throw new Error(`Atlas file ${relPath} has ${lines} lines; safety limit is ${this.limits.maxFileLines} lines`);
      }
      return text;
    } finally {
      await handle?.close();
      await parentHandle.close();
    }
  }

  async readOptional(relPath: string): Promise<string | null> {
    try {
      return await this.readText(relPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async readBounded(relPath: string, options: { tail?: boolean; maxBytes?: number; maxLines?: number } = {}): Promise<BoundedText> {
    const text = await this.readText(relPath);
    const bytes = Math.min(options.maxBytes ?? this.limits.maxReadBytes, this.limits.maxReadBytes);
    const lines = Math.min(options.maxLines ?? this.limits.maxReadLines, this.limits.maxReadLines);
    return options.tail ? truncateTail(text, bytes, lines) : truncateHead(text, bytes, lines);
  }

  private validateContent(content: string, label: string): void {
    const bytes = byteLength(content);
    const lines = lineCount(content);
    if (bytes > this.limits.maxInputBytes) {
      throw new Error(`${label} is ${bytes} bytes; update limit is ${this.limits.maxInputBytes} bytes`);
    }
    if (lines > this.limits.maxInputLines) {
      throw new Error(`${label} has ${lines} lines; update limit is ${this.limits.maxInputLines} lines`);
    }
  }

  private validateFinal(content: string, relPath: string): void {
    const bytes = byteLength(content);
    const lines = lineCount(content);
    if (bytes > this.limits.maxFileBytes) {
      throw new Error(`Update would make ${relPath} ${bytes} bytes; file limit is ${this.limits.maxFileBytes} bytes`);
    }
    if (lines > this.limits.maxFileLines) {
      throw new Error(`Update would make ${relPath} ${lines} lines; file limit is ${this.limits.maxFileLines} lines`);
    }
  }

  private async queued<T>(fullPath: string, operation: () => Promise<T>): Promise<T> {
    const prior = mutationQueues.get(fullPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const chain = prior.then(() => current);
    mutationQueues.set(fullPath, chain);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (mutationQueues.get(fullPath) === chain) mutationQueues.delete(fullPath);
    }
  }

  private async acquireLock(fullPath: string, parentHandle: FileHandle): Promise<() => Promise<void>> {
    const lockPath = join(dirname(fullPath), `.${basename(fullPath)}.atlas.lock`);
    const started = Date.now();
    let handle: FileHandle | undefined;
    while (!handle) {
      try {
        handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const lockInfo = await lstat(lockPath).catch((lstatError) => {
          if (errorCode(lstatError) === "ENOENT") return undefined;
          throw lstatError;
        });
        if (!lockInfo) continue;
        if (lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
          throw new Error(`Unsafe Atlas lock path: ${relative(this.root, lockPath)}`);
        }
        // A lock is never reclaimed from age alone: a delayed live writer may
        // legitimately hold it. Crash-left locks fail closed and require manual
        // removal after the owner is known to be gone.
        if (Date.now() - started >= this.limits.lockTimeoutMs) {
          throw new Error(`Timed out after ${this.limits.lockTimeoutMs}ms waiting for Atlas write lock on ${relative(this.root, fullPath)}; if its owner crashed, inspect and remove ${relative(this.root, lockPath)} manually`);
        }
        await sleep(25);
      }
    }
    try {
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      await handle.sync();
      await this.verifyParentHandle(fullPath, parentHandle);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    const identity = await handle.stat();
    return async () => {
      await handle?.close();
      try {
        const current = await lstat(lockPath);
        if (current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    };
  }

  private async withMutation<T>(
    relPath: string,
    operation: (fullPath: string, parentHandle: FileHandle) => Promise<T>,
  ): Promise<T> {
    const fullPath = this.resolveRelative(relPath);
    return this.queued(fullPath, async () => {
      await this.ensureSafeParent(fullPath);
      await this.assertSafeExistingPath(fullPath, true);
      const parentHandle = await this.openVerifiedParent(fullPath);
      try {
        const release = await this.acquireLock(fullPath, parentHandle);
        try {
          await this.assertSafeExistingPath(fullPath, true);
          await this.verifyParentHandle(fullPath, parentHandle);
          return await operation(fullPath, parentHandle);
        } finally {
          await release();
        }
      } finally {
        await parentHandle.close();
      }
    });
  }

  private async atomicReplaceUnlocked(fullPath: string, content: string, parentHandle: FileHandle): Promise<void> {
    const temporary = join(dirname(fullPath), `.${basename(fullPath)}.atlas-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await this.verifyOpenedPath(temporary, handle);
      await this.verifyParentHandle(fullPath, parentHandle);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      const identity = await handle.stat();
      await handle.close();
      handle = undefined;
      await this.assertSafeExistingPath(fullPath, true);
      await this.verifyParentHandle(fullPath, parentHandle);
      await rename(temporary, fullPath);
      const installed = await lstat(fullPath);
      if (!installed.isFile() || installed.isSymbolicLink()
        || installed.dev !== identity.dev || installed.ino !== identity.ino) {
        throw new Error(`Atlas destination changed during replacement: ${relative(this.root, fullPath)}`);
      }
      await this.verifyParentHandle(fullPath, parentHandle);
      await this.syncDirectory(parentHandle);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch((error) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  }

  async updateAtomic(
    relPath: string,
    update: (current: string | null) => Promise<string | undefined> | string | undefined,
  ): Promise<boolean> {
    return this.withMutation(relPath, async (fullPath, parentHandle) => {
      let current: string | null = null;
      try {
        current = await this.readText(relPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      const content = await update(current);
      if (content === undefined) return false;
      this.validateContent(content, `Replacement for ${relPath}`);
      this.validateFinal(content, relPath);
      await this.atomicReplaceUnlocked(fullPath, content, parentHandle);
      return true;
    });
  }

  async replace(relPath: string, content: string): Promise<void> {
    this.validateContent(content, `Replacement for ${relPath}`);
    this.validateFinal(content, relPath);
    await this.updateAtomic(relPath, () => content);
  }

  async append(relPath: string, content: string): Promise<void> {
    if (content.length === 0) throw new Error("Atlas append content must not be empty");
    this.validateContent(content, `Append for ${relPath}`);
    await this.withMutation(relPath, async (fullPath, parentHandle) => {
      let existing = "";
      try {
        existing = await this.readText(relPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      const suffix = content.endsWith("\n") ? "" : "\n";
      const addition = `${separator}${content}${suffix}`;
      this.validateFinal(existing + addition, relPath);
      const handle = await open(fullPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        await this.verifyOpenedPath(fullPath, handle);
        await this.verifyParentHandle(fullPath, parentHandle);
        await handle.writeFile(addition, "utf8");
        await handle.sync();
        await this.verifyParentHandle(fullPath, parentHandle);
        await this.syncDirectory(parentHandle);
      } finally {
        await handle.close();
      }
    });
  }
}
