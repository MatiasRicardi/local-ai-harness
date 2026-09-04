import { buildApp } from "./app.js";
import { config } from "./config/env.js";
import { consola } from "consola";
import { mkdir } from "node:fs/promises";
import { cleanupStaleTemporaryFiles } from "./files/cleanup.js";

let app: ReturnType<typeof buildApp> | null = null;

async function main() {
  app = buildApp();

  // Ensure the configured upload directory exists, then best-effort remove any
  // stale temporary files left by previous runs or interrupted requests.
  // Startup cleanup is operational hygiene and never blocks startup.
  await mkdir(config.UPLOAD_DIR, { recursive: true });
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

main().catch((err) => {
  consola.error("Failed to start backend:", err);
  process.exit(1);
});
