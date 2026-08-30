import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as process from "node:process";
import { loadConfig } from "../env.js";

const envModuleUrl = new URL("../env.js", import.meta.url);

describe("env configuration", () => {
  let originalEnv: { [key: string]: string } | undefined;

  const restoreProcessEnv = (snapshot: { [key: string]: string }) => {
    // Remove keys introduced by tests.
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) {
        delete process.env[key];
      }
    }

    // Restore original values.
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
  };

  beforeEach(() => {
    // Store original env
    originalEnv = Object.fromEntries(Object.entries(process.env) as Array<[string, string]>);
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv) {
      restoreProcessEnv(originalEnv);
    }
    delete (import.meta as any).resolveCache?.[envModuleUrl.toString()];
  });

  it("loads configuration with defaults", () => {
    // Clear AI_ prefixed env vars
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("AI_")) {
        delete process.env[key];
      }
    });

    const config = loadConfig();

    expect(config.HOST).toBe("127.0.0.1");
    expect(config.PORT).toBe(3000);
    expect(config.CORS_ORIGINS).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
    expect(config.REQUEST_TIMEOUT_MS).toBe(60000);
    expect(config.MAX_UPLOAD_SIZE_MB).toBe(10);
    expect(config.UPLOAD_DIR).toBe("./uploads");
    expect(config.DEFAULT_PROVIDER_TIMEOUT_MS).toBe(120000);
    expect(config.ENVIRONMENT).toBe("development");
  });

  it("parses custom environment variables", () => {
    process.env.AI_HOST = "0.0.0.0";
    process.env.AI_PORT = "8080";
    process.env.AI_CORS_ORIGINS = "http://example.com,http://test.com";
    process.env.AI_REQUEST_TIMEOUT_MS = "60000";
    process.env.AI_MAX_UPLOAD_SIZE_MB = "5";
    process.env.AI_UPLOAD_DIR = "./temp/uploads";
    process.env.AI_DEFAULT_PROVIDER_TIMEOUT_MS = "180000";
    process.env.AI_ENVIRONMENT = "production";

    const config = loadConfig();

    expect(config.HOST).toBe("0.0.0.0");
    expect(config.PORT).toBe(8080);
    expect(config.CORS_ORIGINS).toEqual([
      "http://example.com",
      "http://test.com",
    ]);
    expect(config.REQUEST_TIMEOUT_MS).toBe(60000);
    expect(config.MAX_UPLOAD_SIZE_MB).toBe(5);
    expect(config.UPLOAD_DIR).toBe("./temp/uploads");
    expect(config.DEFAULT_PROVIDER_TIMEOUT_MS).toBe(180000);
    expect(config.ENVIRONMENT).toBe("production");
  });

  it("throws error on invalid port", () => {
    process.env.AI_HOST = "127.0.0.1";
    process.env.AI_PORT = "invalid";

    expect(() => loadConfig()).toThrow(/Invalid configuration/);
  });

  it("throws error on negative timeout", () => {
    process.env.AI_HOST = "127.0.0.1";
    process.env.AI_PORT = "3000";
    process.env.AI_REQUEST_TIMEOUT_MS = "-100";

    expect(() => loadConfig()).toThrow(/Invalid configuration/);
  });

  it("throws error on invalid environment", () => {
    process.env.AI_HOST = "127.0.0.1";
    process.env.AI_PORT = "3000";
    process.env.AI_ENVIRONMENT = "staging";

    expect(() => loadConfig()).toThrow(/Invalid configuration/);
  });

  it("trims CORS origins", () => {
    process.env.AI_CORS_ORIGINS = "  http://a.com  ,  http://b.com  ";

    const config = loadConfig();

    expect(config.CORS_ORIGINS).toEqual(["http://a.com", "http://b.com"]);
  });
});
