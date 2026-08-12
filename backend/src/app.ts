import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import health from "./routes/health.js";
import providerTest from "./routes/provider.js";
import chat from "./routes/chat.js";
import { config } from "./config/env.js";


export function buildApp(): FastifyInstance {
  const app = Fastify({
    bodyLimit: config.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  });

  app.register(cors, {
    origin: config.CORS_ORIGINS,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });

  app.register(health);
  app.register(providerTest);
  app.register(chat);

  return app;
}
