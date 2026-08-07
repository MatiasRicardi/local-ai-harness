import type { FastifyPluginAsync } from "fastify";

const health: FastifyPluginAsync = async (server) => {
  server.get("/api/health", async () => {
    return {
      status: "ok",
      name: "Local AI Harness",
      version: "0.0.0",
    };
  });
};

export default health;
