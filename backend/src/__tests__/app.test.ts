import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../app.js";

describe("app", () => {
  it("builds a Fastify instance", () => {
    const app = buildApp();
    expect(app).toBeDefined();
  });
});

describe("health endpoint", () => {
  let app: ReturnType<typeof buildApp>;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns 200 with status, name and version", async () => {
    app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("name", "Local AI Harness");
    expect(body).toHaveProperty("version", "0.0.0");
  });
});
