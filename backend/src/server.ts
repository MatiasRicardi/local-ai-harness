import { buildApp } from "./app.js";
import { config } from "./config/env.js";
import { consola } from "consola";
import { mkdir } from "node:fs/promises";
import { cleanupStaleTemporaryFiles } from "./files/cleanup.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

let app: ReturnType<typeof buildApp> | null = null;

// The upload directory is required: a failure here rejects main() before
// app.listen() runs, so the process exits (fail-fast) rather than starting in
// a state where upload routes cannot work. This is intentionally NOT
// best-effort, unlike the stale-file cleanup that follows.
export async function ensureUploadDirectory(): Promise<void> {
  await mkdir(config.UPLOAD_DIR, { recursive: true });
}

export async function main() {
  app = buildApp();

  // Ensure the configured upload directory exists, then best-effort remove any
  // stale temporary files left by previous runs or interrupted requests.
  // Cleanup is operational hygiene and never blocks startup.
  await ensureUploadDirectory();
  try {
    const summary = await cleanupStaleTemporaryFiles(
      config.UPLOAD_DIR,
      config.TEMP_FILE_MAX_AGE_MS,
    );
    consola.info(
      `[upload] temporary_file_cleanup_completed scanned=${summary.scanned} deleted=${summary.deleted} skipped=${summary.skipped} failed=${summary.failed}`,
    );
  } catch {
    // A directory-listing failure is logged once, safely, and startup continues.
    consola.info("[upload] stale_cleanup_scan_failed");
  }

  await app.listen({ port: config.PORT, host: config.HOST });
  consola.success(`Backend listening on http://${config.HOST}:${config.PORT}`);
  consola.info(`Environment: ${config.ENVIRONMENT}`);
}

// Handle shutdown signals
process.on("SIGINT", async () => {
  if (app) {
    consola.info("Shutting down backend...");
    await app.close();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (app) {
    consola.info("Shutting down backend...");
    await app.close();
  }
  process.exit(0);
});

// Auto-start only when this module is the entry point (e.g. `node dist/server.js`
// or `tsx server.ts`). When imported (e.g. by tests) the caller decides when to
// start, so tests can exercise main()/ensureUploadDirectory() in isolation.
const invokedAsMainEntry =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedAsMainEntry) {
  main().catch((err) => {
    consola.error("Failed to start backend:", err);
    process.exit(1);
  });
}
