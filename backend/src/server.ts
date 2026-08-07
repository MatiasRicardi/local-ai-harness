import "dotenv/config";
import { buildApp } from "./app.js";
import { config } from "./config/env.js";

let app: ReturnType<typeof buildApp> | null = null;

async function main() {
  app = buildApp();

  await app.listen({ port: config.PORT, host: config.HOST });
  console.log(`Backend listening on http://${config.HOST}:${config.PORT}`);
  console.log(`Environment: ${config.ENVIRONMENT}`);
}

// Handle shutdown signals
process.on("SIGINT", async () => {
  if (app) {
    console.log("\nShutting down backend...");
    await app.close();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (app) {
    console.log("\nShutting down backend...");
    await app.close();
  }
  process.exit(0);
});

main().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
