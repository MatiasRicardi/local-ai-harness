import type { FastifyPluginAsync } from "fastify";
import pkg from "../../package.json";

const health: FastifyPluginAsync = async (server) => {
  server.get("/api/health", async () => {
    return {
      status: "ok",
      name: "Local AI Harness",
      version: pkg.version,
    };
  });
};

export default health;
