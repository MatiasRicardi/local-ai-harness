import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir } from "node:fs/promises";

vi.mock("node:fs/promises");
vi.mock("../app.js", () => ({
  buildApp: vi.fn(),
}));
vi.mock("../files/cleanup.js", () => ({
  cleanupStaleTemporaryFiles: vi.fn(),
}));

import { main, ensureUploadDirectory } from "../server.js";
import { buildApp } from "../app.js";
import { cleanupStaleTemporaryFiles } from "../files/cleanup.js";

const CLEANUP_SUMMARY = {
  scanned: 0,
  deleted: 0,
  skipped: 0,
  failed: 0,
  thresholdMs: 0,
};

describe("server startup", () => {
  beforeEach(() => {
    vi.mocked(mkdir).mockReset();
    vi.mocked(buildApp).mockReset();
    vi.mocked(cleanupStaleTemporaryFiles).mockReset();
  });

  describe("ensureUploadDirectory", () => {
    it("creates the configured upload directory", async () => {
      vi.mocked(mkdir).mockResolvedValue(undefined);

      await expect(ensureUploadDirectory()).resolves.toBeUndefined();
      expect(mkdir).toHaveBeenCalledWith("./uploads", { recursive: true });
    });

    it("rejects when mkdir fails so startup fails fast", async () => {
      vi.mocked(mkdir).mockRejectedValue(new Error("EACCES: permission denied"));

      await expect(ensureUploadDirectory()).rejects.toThrow("EACCES");
    });
  });

  describe("main", () => {
    it("rejects before app.listen when the upload directory cannot be created", async () => {
      const listen = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn().mockResolvedValue(undefined);
      vi.mocked(buildApp).mockReturnValue({
        listen,
        close,
      } as unknown as ReturnType<typeof buildApp>);
      vi.mocked(mkdir).mockRejectedValue(new Error("EACCES: permission denied"));
      vi.mocked(cleanupStaleTemporaryFiles).mockResolvedValue(CLEANUP_SUMMARY);

      await expect(main()).rejects.toThrow("EACCES");
      expect(listen).not.toHaveBeenCalled();
    });
  });
});
