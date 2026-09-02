import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError,
  normalizeError,
  serializeResponse,
} from "../errorHandler.js";
import {
  OpenAICompatibleClient,
  ProviderClientError,
} from "../../provider/client.js";
import { ExtractionError } from "../../extractors/ExtractionError.js";

describe("error handler", () => {
  it("serializes AppError without its internal cause", () => {
    const response = serializeResponse(
      new AppError({
        code: "FILE_UPLOAD_ERROR",
        statusCode: 400,
        message: "The file could not be uploaded.",
        detail: "A single file is required.",
        cause: new Error("SECRET_TEST_API_KEY_123"),
      }),
    );

    expect(response).toEqual({
      error: {
        code: "FILE_UPLOAD_ERROR",
        message: "The file could not be uploaded.",
        detail: "A single file is required.",
      },
    });
    expect(JSON.stringify(response)).not.toContain("SECRET_TEST_API_KEY_123");
  });

  it("normalizes Zod failures to the shared validation response", () => {
    const result = z.object({ maxTokens: z.number().min(1024) }).safeParse({ maxTokens: 1 });
    if (result.success) {
      throw new Error("Expected validation to fail");
    }

    const appError = normalizeError(result.error);

    expect(appError).toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      userMessage: "The request contains invalid fields.",
    });
    expect(appError.detail).toContain("maxTokens");
  });

  it.each([
    [OpenAICompatibleClient.ErrorType.NETWORK_ERROR, "PROVIDER_UNREACHABLE", 502],
    [OpenAICompatibleClient.ErrorType.TIMEOUT, "PROVIDER_TIMEOUT", 504],
    [OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE, "INVALID_PROVIDER_RESPONSE", 502],
  ])("normalizes provider %s failures", (errorType, code, statusCode) => {
    const appError = normalizeError(new ProviderClientError(errorType, "private provider response"));

    expect(appError).toMatchObject({ code, statusCode });
  });

  it("normalizes provider authorization failures", () => {
    const appError = normalizeError(
      new ProviderClientError(
        OpenAICompatibleClient.ErrorType.HTTP_ERROR,
        "Provider returned HTTP 401",
        { cause: new Error("Provider returned HTTP 401: Unauthorized") },
      ),
    );

    expect(appError).toMatchObject({
      code: "PROVIDER_UNAUTHORIZED",
      statusCode: 401,
    });
  });

  it("normalizes extraction and context-limit failures", () => {
    const extractionError = normalizeError(new ExtractionError("The PDF could not be processed."));
    const conversationError = normalizeError(
      new Error("The current conversation is too large for the configured context size."),
    );
    const documentError = normalizeError(
      new Error("The current conversation is too large to include the attached document."),
    );

    expect(extractionError).toMatchObject({ code: "EXTRACTION_FAILED", statusCode: 400 });
    expect(conversationError).toMatchObject({ code: "CONTEXT_TOO_LARGE", statusCode: 400 });
    expect(documentError).toMatchObject({ code: "DOCUMENT_CONTEXT_TOO_LARGE", statusCode: 400 });
  });

  it("returns a safe response for unexpected failures", () => {
    const response = serializeResponse(
      normalizeError(
        new Error(
          "SECRET_TEST_API_KEY_123 /tmp/private/upload.pdf SUPER_PRIVATE_DOCUMENT_TEXT stack trace",
        ),
      ),
    );

    expect(response).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    });
  });
});