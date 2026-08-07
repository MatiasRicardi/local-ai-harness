import { z } from "zod";

// Default configuration values
const DEFAULTS = {
  HOST: "127.0.0.1",
  PORT: 3000,
  CORS_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
  REQUEST_TIMEOUT_MS: 30000,
  MAX_UPLOAD_SIZE_MB: 10,
  UPLOAD_DIR: "./uploads",
  DEFAULT_PROVIDER_TIMEOUT_MS: 120000,
  ENVIRONMENT: "development",
};

// Zod schema for environment validation
const envSchema = z.object({
  HOST: z.string().min(1),
  PORT: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive()),
  CORS_ORIGINS: z.string().min(1),
  REQUEST_TIMEOUT_MS: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive()),
  MAX_UPLOAD_SIZE_MB: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive()),
  UPLOAD_DIR: z.string().min(1),
  DEFAULT_PROVIDER_TIMEOUT_MS: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive()),
  ENVIRONMENT: z.enum(["development", "production", "test"]),
});

// Parse environment variables
export function loadConfig(): Config {
  // Start with defaults
  const parsed: Record<string, string> = {
    HOST: DEFAULTS.HOST,
    PORT: DEFAULTS.PORT.toString(),
    CORS_ORIGINS: DEFAULTS.CORS_ORIGINS,
    REQUEST_TIMEOUT_MS: DEFAULTS.REQUEST_TIMEOUT_MS.toString(),
    MAX_UPLOAD_SIZE_MB: DEFAULTS.MAX_UPLOAD_SIZE_MB.toString(),
    UPLOAD_DIR: DEFAULTS.UPLOAD_DIR,
    DEFAULT_PROVIDER_TIMEOUT_MS: DEFAULTS.DEFAULT_PROVIDER_TIMEOUT_MS.toString(),
    ENVIRONMENT: DEFAULTS.ENVIRONMENT,
  };

  // Override with environment variables if present
  Object.keys(parsed).forEach((key) => {
    const envKey = `AI_${key}`;
    if (process.env[envKey] !== undefined) {
      parsed[key] = process.env[envKey];
    }
  });

  try {
    const result = envSchema.parse(parsed);

    // Convert CORS origins from comma-separated string to array
    const corsOrigins = result.CORS_ORIGINS.split(",").map((origin) => origin.trim());

    return {
      ...result,
      CORS_ORIGINS: corsOrigins,
    } as Config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const zodError = error as z.ZodError<z.ZodRawShape>;
      const errors = zodError.issues.map((e) =>
        `${e.path.join(".")}: ${e.message}`
      );
      throw new Error(`Invalid configuration: ${errors.join("; ")}`);
    }
    throw error;
  }
}

// Type for configuration
export type Config = z.infer<typeof envSchema> & {
  CORS_ORIGINS: string[];
};

// Export default configuration for testing
export const config = loadConfig();
