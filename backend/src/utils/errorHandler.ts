import { OpenAICompatibleClient } from "../provider/client.js";

/**
 * Maps a structured provider error to an HTTP response code and body.
 * Used by route handlers to return consistent error responses.
 */
export function mapErrorToReply(
  errorInfo: ReturnType<typeof OpenAICompatibleClient.prototype.getErrorInfo>,
): { code: number; body: { success: false; error: string } } {
  switch (errorInfo.errorType) {
    case OpenAICompatibleClient.ErrorType.TIMEOUT:
      return {
        code: 504,
        body: { success: false, error: "Provider request timed out" },
      };

    case OpenAICompatibleClient.ErrorType.HTTP_ERROR:
      if (
        errorInfo.message.includes("401") ||
        errorInfo.message.includes("403")
      ) {
        return {
          code: 401,
          body: {
            success: false,
            error: "Provider authentication or authorization failed",
          },
        };
      }
      return {
        code: 502,
        body: { success: false, error: "Provider returned an invalid response" },
      };

    case OpenAICompatibleClient.ErrorType.MALFORMED_RESPONSE:
      return {
        code: 400,
        body: { success: false, error: "Provider returned a malformed response" },
      };

    case OpenAICompatibleClient.ErrorType.NETWORK_ERROR:
      return {
        code: 502,
        body: { success: false, error: "Provider connection failed" },
      };

    default:
      return {
        code: 500,
        body: {
          success: false,
          error: errorInfo.message || "Provider request failed",
        },
      };
  }
}
