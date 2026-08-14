import { buildApp } from "./app.js";
import { config } from "./config/env.js";
import { consola } from "consola";

let app: ReturnType<typeof buildApp> | null = null;

async function main() {
  app = buildApp();

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
