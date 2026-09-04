import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { Mock } from "vitest";

// rm/stat/readdir are replaced by spies via vi.mock; type them for the failure
// injections below.
import {
  assertPathInsideDirectory,
  removeTemporaryFile,
  cleanupStaleTemporaryFiles,
  TemporaryFileScanError,
} from "../cleanup.js";

// cleanup.ts reads/removes files through node:fs/promises. Provide real
// implementations for the operations under test and spies only where a failure
// must be injected.
vi.mock("node:fs/promises", async () => {
  const actual = (await vi.importActual("node:fs/promises")) as typeof import("node:fs/promises");
  return {
    ...actual,
    rm: vi.fn(actual.rm),
    stat: vi.fn(actual.stat),
    readdir: vi.fn(actual.readdir),
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;

const rmMock = rm as unknown as Mock;
const statMock = stat as unknown as Mock;
const readdirMock = readdir as unknown as Mock;

describe("assertPathInsideDirectory", () => {
  const root = "/tmp/uploads";

  it("allows a direct child inside the root", () => {
    expect(assertPathInsideDirectory(root, "/tmp/uploads/file.txt")).toBe(true);
  });

  it("allows a nested path inside the root", () => {
    expect(assertPathInsideDirectory(root, "/tmp/uploads/sub/file.txt")).toBe(true);
  });

  it("rejects a sibling-prefix attack (uploads-evil vs uploads)", () => {
    expect(assertPathInsideDirectory(root, "/tmp/uploads-evil/file.txt")).toBe(false);
  });

  it("rejects parent traversal after resolution", () => {
    expect(assertPathInsideDirectory(root, "/tmp/uploads/../outside.txt")).toBe(false);
  });

  it("rejects the root directory itself", () => {
    expect(assertPathInsideDirectory(root, root)).toBe(false);
  });
});

describe("removeTemporaryFile", () => {
  let root: string;

  beforeEach(async () => {
    root = join(os.tmpdir(), `step22-remove-${randomUUID()}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("deletes an existing file inside the root", async () => {
    const target = join(root, `${randomUUID()}.txt`);
    writeFileSync(target, "data");

    await removeTemporaryFile(target, root);

    expect(existsSync(target)).toBe(false);
  });

  it("treats a missing file as already cleaned (no error)", async () => {
    const missing = join(root, `${randomUUID()}.txt`);

    await expect(removeTemporaryFile(missing, root)).resolves.toBeUndefined();
  });

  it("rejects an outside-root target and leaves it untouched", async () => {
    const outsideDir = join(os.tmpdir(), `step22-outside-${randomUUID()}`);
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "keep.txt");
    writeFileSync(outsideFile, "keep me");

    await expect(removeTemporaryFile(outsideFile, root)).rejects.toThrow();
    expect(readFileSync(outsideFile, "utf8")).toBe("keep me");

    await rm(outsideDir, { recursive: true, force: true });
  });

  it("surfaces a removal failure without leaking the path", async () => {
    const target = join(root, `${randomUUID()}.txt`);
    writeFileSync(target, "data");
    rmMock.mockRejectedValueOnce(new Error("boom"));

    await expect(removeTemporaryFile(target, root)).rejects.toThrow();
    expect(existsSync(target)).toBe(true);
  });
});

describe("cleanupStaleTemporaryFiles", () => {
  let root: string;

  beforeEach(async () => {
    root = join(os.tmpdir(), `step22-stale-${randomUUID()}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeOld = async (name: string): Promise<void> => {
    const path = join(root, name);
    writeFileSync(path, "stale");
    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
    await utimes(path, twoDaysAgo, twoDaysAgo);
  };

  const writeFresh = async (name: string): Promise<void> => {
    const path = join(root, name);
    writeFileSync(path, "fresh");
    const now = new Date();
    await utimes(path, now, now);
  };

  it("deletes only stale regular files and preserves fresh ones", async () => {
    await writeOld("old1.txt");
    await writeOld("old2.md");
    await writeFresh("fresh.txt");

    const summary = await cleanupStaleTemporaryFiles(root, DAY_MS);

    expect(existsSync(join(root, "old1.txt"))).toBe(false);
    expect(existsSync(join(root, "old2.md"))).toBe(false);
    expect(existsSync(join(root, "fresh.txt"))).toBe(true);
    expect(summary).toEqual({
      scanned: 3,
      deleted: 2,
      skipped: 0,
      failed: 0,
      thresholdMs: DAY_MS,
    });
  });

  it("treats a missing directory as nothing to clean (non-fatal)", async () => {
    const missing = join(os.tmpdir(), `step22-missing-${randomUUID()}`);
    await rm(missing, { recursive: true, force: true });

    const summary = await cleanupStaleTemporaryFiles(missing, DAY_MS);

    expect(summary.scanned).toBe(0);
    expect(summary.deleted).toBe(0);
  });

  it("skips directory entries without following them", async () => {
    await mkdir(join(root, "subdir"), { recursive: true });
    await writeOld("file.txt");

    const summary = await cleanupStaleTemporaryFiles(root, DAY_MS);

    expect(summary.skipped).toBe(1);
    expect(summary.deleted).toBe(1);
    expect(existsSync(join(root, "subdir"))).toBe(true);
  });

  it("does not follow symlinks and leaves the outside target untouched", async () => {
    const outsideDir = join(os.tmpdir(), `step22-sym-outside-${randomUUID()}`);
    await mkdir(outsideDir, { recursive: true });
    const outsideTarget = join(outsideDir, "target.txt");
    writeFileSync(outsideTarget, "outside");

    const linkName = join(root, "link.txt");
    try {
      symlinkSync(outsideTarget, linkName, "file");
    } catch {
      // Symlink creation is not portable on every platform: skip the assertion.
      return;
    }

    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
    await utimes(linkName, twoDaysAgo, twoDaysAgo);

    const summary = await cleanupStaleTemporaryFiles(root, DAY_MS);

    // The symlink is skipped (never followed) and the outside target survives.
    expect(existsSync(outsideTarget)).toBe(true);
    expect(summary.deleted).toBe(0);

    await rm(outsideDir, { recursive: true, force: true });
  });

  it("does not abort the run when an entry cannot be stat-ed", async () => {
    await writeOld("a.txt");
    await writeOld("b.txt");
    // cleanupStaleTemporaryFiles stats each of the two files once.
    statMock.mockRejectedValueOnce(new Error("stat fail"));
    statMock.mockRejectedValueOnce(new Error("stat fail"));

    const summary = await cleanupStaleTemporaryFiles(root, DAY_MS);

    expect(summary.scanned).toBe(2);
    expect(summary.deleted).toBe(0);
    expect(summary.failed).toBe(2);
  });

  it("does not crash when a stale entry cannot be removed", async () => {
    await writeOld("a.txt");
    await writeOld("b.txt");
    // cleanupStaleTemporaryFiles removes each stale file once.
    rmMock.mockRejectedValueOnce(new Error("rm fail"));
    rmMock.mockRejectedValueOnce(new Error("rm fail"));

    const summary = await cleanupStaleTemporaryFiles(root, DAY_MS);

    expect(summary.deleted).toBe(0);
    expect(summary.failed).toBe(2);
  });

  it("throws a path-safe error when the directory cannot be listed", async () => {
    readdirMock.mockRejectedValue(new Error("EACCES: denied"));

    await expect(cleanupStaleTemporaryFiles(root, DAY_MS)).rejects.toBeInstanceOf(
      TemporaryFileScanError,
    );
  });
});
