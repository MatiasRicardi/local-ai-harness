import { readdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { Stats } from "node:fs";
import * as path from "node:path";

/**
 * Temporary-file cleanup for uploaded documents (Step 22).
 *
 * Every operation is anchored to the configured upload directory and is
 * defensive by design:
 *  - each deletion target is verified to stay strictly inside the root
 *    (never a naive string-prefix test);
 *  - symlinks and directories are never followed;
 *  - missing files are treated as already cleaned;
 *  - failures are surfaced without leaking paths, file contents, or raw error
 *    details (CWE-539).
 *
 * The low-level helpers never log; the caller owns the single logging
 * boundary so each failure is reported exactly once.
 */

/**
 * Verify that `candidatePath` resolves to a location strictly inside `root`.
 *
 * Uses resolved absolute paths and `path.relative()` so a sibling such as
 * `/tmp/uploads-evil/file` cannot match root `/tmp/uploads`. The root itself is
 * never considered "inside" and therefore cannot be deleted.
 */
export function assertPathInsideDirectory(root: string, candidatePath: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(candidatePath);

  // The root directory itself must never be deletable.
  if (target === base) {
    return false;
  }

  const relative = path.relative(base, target);

  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/**
 * Safely remove a single temporary file.
 *
 * Flow: verify containment → remove.
 *  - target outside the upload root → rejected, nothing is deleted;
 *  - `fs.rm(..., { force: true })` already treats a missing target (ENOENT) as
 *    success, so an already-deleted file is a no-op;
 *  - any other removal failure is thrown so the caller can log it safely.
 */
export async function removeTemporaryFile(
  filePath: string,
  uploadDir: string,
): Promise<void> {
  if (!assertPathInsideDirectory(uploadDir, filePath)) {
    // Refuse to touch anything outside the configured root, without side effects.
    throw new Error("Refusing to remove a file outside the upload directory.");
  }

  await rm(filePath, { force: true });
}

/**
 * Summary of a stale-file cleanup run. Counts only; never carries filenames,
 * paths, or document content.
 */
export interface StaleCleanupSummary {
  scanned: number;
  deleted: number;
  skipped: number;
  failed: number;
  thresholdMs: number;
}

/**
 * Thrown only when the upload directory itself cannot be listed for a
 * non-`ENOENT` reason. Carries no message that could contain a path so the
 * caller can log it safely. Best-effort startup cleanup must never block
 * startup.
 */
export class TemporaryFileScanError extends Error {
  constructor() {
    super("temporary-file scan failed");
    this.name = "TemporaryFileScanError";
  }
}

/**
 * Remove stale temporary files left in the configured upload directory (for
 * example from previous server runs or interrupted requests).
 *
 * Policy:
 *  - regular files are age-evaluated; directories, symlinks, and other entry
 *    types are skipped and never followed (no recursion);
 *  - a file is stale when `now - mtimeMs >= maxAgeMs` (one `now` per run);
 *  - `ENOENT` on listing is treated as "nothing to clean";
 *  - per-entry stat/rem failures are counted and never abort the run;
 *  - listing the directory itself fails only for a non-`ENOENT` reason, in
 *    which case {@link TemporaryFileScanError} is thrown for the caller to log.
 */
export async function cleanupStaleTemporaryFiles(
  uploadDir: string,
  maxAgeMs: number,
): Promise<StaleCleanupSummary> {
  const root = path.resolve(uploadDir);
  const now = Date.now();

  const summary: StaleCleanupSummary = {
    scanned: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    thresholdMs: maxAgeMs,
  };

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    // Missing directory: nothing to clean (bootstrap normally creates it first).
    const code =
      err instanceof Error && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      return summary;
    }
    // Any other listing failure is surfaced once for the caller to log safely.
    void err;
    throw new TemporaryFileScanError();
  }

  for (const entry of entries) {
    summary.scanned++;
    const fullpath = path.join(root, entry.name);

    if (entry.isFile()) {
      await evaluateStaleFile(fullpath, uploadDir, now, maxAgeMs, summary);
    } else {
      // Directory, symlink, socket, fifo, etc.: skip and never follow.
      summary.skipped++;
    }
  }

  return summary;
}

async function evaluateStaleFile(
  fullpath: string,
  uploadDir: string,
  now: number,
  maxAgeMs: number,
  summary: StaleCleanupSummary,
): Promise<void> {
  let stats: Stats;
  try {
    stats = await stat(fullpath);
  } catch {
    // Could not stat this entry: count it as failed and keep going.
    summary.failed++;
    return;
  }

  // Fresh file: preserve it.
  if (now - stats.mtimeMs < maxAgeMs) {
    return;
  }

  try {
    await removeTemporaryFile(fullpath, uploadDir);
    summary.deleted++;
  } catch {
    // Could not delete this entry: count it as failed and keep going.
    summary.failed++;
  }
}
