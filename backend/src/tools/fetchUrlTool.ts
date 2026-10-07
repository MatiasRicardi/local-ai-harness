import { z } from "zod";
import { AppError } from "../utils/errorHandler.js";
import { fetchUrl, type FetchUrlResponse } from "./fetchUrlClient.js";
import {
  extractFetchUrlContent,
  MAX_TITLE_CHARACTERS,
} from "./fetchUrlContent.js";
import { sanitizeSourceCandidate } from "./sourceSanitization.js";
import { UNTRUSTED_EXTERNAL_WEB_CONTENT_INSTRUCTIONS } from "./untrustedContent.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

// ── Fetch URL tool ────────────────────────────────────────────────────────────
//
// Adapter that composes the Step 47 destination policy, the Step 48 network
// client and the Step 49 content extraction into a single model-callable
// `fetch_url` tool. It never knows about HTTP internals, MIME handling or the
// resolved IPs: those stay inside the client. It owns ONLY the tool-shaped
// concerns — the definition, argument validation, the harness-authored
// untrusted-content wrapper, and the source metadata (without an id, which the
// turn source accumulator assigns).
//
// `fetch_url` reads one public page and returns its extracted text inside a
// clear untrusted boundary, plus `{ source: { title, url } }` so the orchestrator
// can expose a clickable source. It does not execute JavaScript and must never be
// used for local/private destinations — that is enforced by the client policy.

/** OpenAI-style tool definition. Only `url` is model-controllable. */
export const fetchUrlToolDefinition: ToolDefinitionShape = {
  name: "fetch_url",
  description:
    "Read the text of a specific public web page or resource. Use this after\n" +
    "web_search when the snippets are insufficient to answer. It does not\n" +
    "execute JavaScript and should not be used for local or private network\n" +
    "resources.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "An absolute HTTP(S) URL to read.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

/** Internal generic tool-definition shape (structural subset of `Tool.definition`). */
interface ToolDefinitionShape {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Strict schema for model-supplied fetch_url arguments.
 *
 * Mirrors the published tool definition exactly: only `url` is allowed
 * (`.strict()` rejects extra keys). The url must be an absolute http(s) URL so a
 * malformed or non-web argument is rejected early in `validate()`. DNS/SSRF
 * safety is NOT checked here: a public-looking hostname that resolves private is
 * a policy decision made at execution time by the client.
 */
const fetchUrlToolArgsSchema = z.object({
  url: z
    .string()
    .refine(isHttpSUrl, "url must be an absolute http(s) URL"),
}).strict();

/** True when `value` parses as an absolute http(s) URL. */
function isHttpSUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Pre-flight validation of a model-supplied fetch_url call.
 *
 * Runs BEFORE any `tool_start` event, exactly like the other tools. It rejects
 * a missing/non-http(s)/malformed url or unknown extra fields as a stable,
 * concise `VALIDATION_ERROR`. Non-web destinations (private network, …) are
 * deliberately NOT rejected here: they are a policy decision made at execution
 * time, so they surface as `TOOL_EXECUTION_FAILED` after `tool_start`.
 */
function validateFetchUrlArgs(args: unknown): void {
  if (!fetchUrlToolArgsSchema.safeParse(args).success) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      message: "Invalid fetch_url arguments.",
    });
  }
}

/**
 * Resolve a model-friendly source title with the fallback order:
 * extracted title -> `hostname` + path (or hostname) -> final url.
 *
 * The remote page never controls the title used for the source link: it is
 * always a harness-derived, length-bounded string.
 */
function resolveSourceTitle(extractedTitle: string | undefined, finalUrl: string): string {
  if (typeof extractedTitle === "string" && extractedTitle.trim().length > 0) {
    return extractedTitle.slice(0, MAX_TITLE_CHARACTERS);
  }

  try {
    const parsed = new URL(finalUrl);
    const hostPath = parsed.pathname !== "/" ? `${parsed.hostname}${parsed.pathname}` : parsed.hostname;
    if (hostPath.length > 0) {
      return hostPath.slice(0, MAX_TITLE_CHARACTERS);
    }
  } catch {
    // Fall through to the raw url below.
  }

  return finalUrl.slice(0, MAX_TITLE_CHARACTERS);
}

/**
 * Build the harness-authored untrusted wrapper around the extracted page text.
 *
 * The wrapper is laid out with blank-line-separated sections so the generic
 * budget truncator (`truncateContentPreservingStructure`) can drop whole
 * sections at their boundaries — in particular the page-content section can be
 * dropped independently of the header. `sourceContentStart` is the offset, inside
 * the returned wrapper, where the FIRST REAL CHARACTER of the extracted page
 * text begins: everything before it (untrusted-content header, the blank-line
 * section separator and the opening `<page-content>` tag plus its newline) is
 * harness-authored. It is measured from the very same strings that make up the
 * wrapper, so it cannot drift, and it can never be forged by the remote page or
 * the model. The orchestrator uses it to decide whether real page text was
 * actually delivered to the model.
 *
 * Exported for tests: this exact byte layout is what the delivery decision is
 * based on, so the tests exercise the real wrapper instead of a copy of it.
 */
export function buildUntrustedPageWrapper(params: {
  finalUrl: string;
  title: string;
  extractedText: string;
}): { wrapper: string; sourceContentStart: number } {
  const { finalUrl, title, extractedText } = params;
  const header =
    `[BEGIN UNTRUSTED EXTERNAL WEB PAGE]\n` +
    `${UNTRUSTED_EXTERNAL_WEB_CONTENT_INSTRUCTIONS}\n` +
    `URL: ${finalUrl}\n` +
    `Title: ${title}`;
  // Everything up to the extracted text is harness-authored: the header, the
  // blank-line section separator and the opening `<page-content>` tag with its
  // newline. The offset is taken from this same prefix string, so it always
  // points at the first character of `extractedText` inside the wrapper.
  const prefix = `${header}\n\n<page-content>\n`;
  const footer = "[END UNTRUSTED EXTERNAL WEB PAGE]";
  const wrapper = `${prefix}${extractedText}\n</page-content>\n\n${footer}`;
  const sourceContentStart = prefix.length;
  return { wrapper, sourceContentStart };
}

/**
 * Create the `fetch_url` tool.
 *
 * Stateless and credential-free: it needs no configuration. The harness-internal
 * per-turn limit (2) keeps it inside the same global tool cap the orchestrator
 * already enforces for every tool. This policy is never serialized into the
 * provider-facing definition.
 */
export function createFetchUrlTool(): Tool {
  return {
    definition: fetchUrlToolDefinition,
    // Harness-internal per-turn limit: at most two fetch_url runs per user turn.
    executionPolicy: { maxExecutionsPerTurn: 2 },
    validate: validateFetchUrlArgs,

    async execute(
      args: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      // Validate our own arguments before any external work. Invalid input
      // surfaces through the existing VALIDATION_ERROR path; the client is
      // never contacted. (The orchestrator also runs `validate()` before
      // tool_start; this covers direct callers.)
      validateFetchUrlArgs(args);

      const { url } = fetchUrlToolArgsSchema.parse(args);

      // The client performs the destination policy (Step 47), the bounded
      // network download (Step 48) and MIME/size guards. Any expected failure
      // (blocked private destination, timeout, binary MIME, too large,
      // non-2xx) propagates out of here and is mapped to TOOL_EXECUTION_FAILED
      // by the orchestrator's generic boundary — no fetched body, DNS detail or
      // stack trace reaches the client.
      const response: FetchUrlResponse = await fetchUrl(url, {
        signal: context.signal,
      });

      const extracted = extractFetchUrlContent({
        url: response.url,
        contentType: response.contentType,
        content: response.content,
      });

      const finalUrl = response.url;
      const title = resolveSourceTitle(extracted.title, finalUrl);

      // No usable page content: surface a short, honest note and skip the source
      // entirely (no `sourceContentStart` => the orchestrator never emits a
      // source for it). The remote page still cannot inject anything past the
      // harness-authored wrapper.
      if (extracted.text.trim().length === 0) {
        return {
          content:
            `[BEGIN UNTRUSTED EXTERNAL WEB PAGE]\n` +
            `${UNTRUSTED_EXTERNAL_WEB_CONTENT_INSTRUCTIONS}\n` +
            `URL: ${finalUrl}\nTitle: ${title}\n\n` +
            `<page-content>\n(no readable content on this page)\n</page-content>\n\n` +
            "[END UNTRUSTED EXTERNAL WEB PAGE]",
        };
      }

      const candidate = sanitizeSourceCandidate({ title, url: finalUrl });
      if (candidate === undefined) {
        // Should not happen: finalUrl is a validated http(s) URL. Never emit a
        // source we could not sanitize, but still return the fetched content.
        const { wrapper } = buildUntrustedPageWrapper({ finalUrl, title, extractedText: extracted.text });
        return { content: wrapper };
      }

      const { wrapper, sourceContentStart } = buildUntrustedPageWrapper({
        finalUrl,
        title,
        extractedText: extracted.text,
      });

      return {
        content: wrapper,
        metadata: {
          source: candidate,
          sourceContentStart,
        },
      };
    },
  };
}
