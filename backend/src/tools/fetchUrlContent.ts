// ── Fetch URL content extraction (pure, dependency-free) ─────────────────────
//
// Converts the bounded textual body returned by `fetchUrlClient` (Step 48) into
// compact, model-friendly content. This is intentionally a lightweight
// extraction layer, NOT a standards-complete HTML/XML parser or a Readability
// clone: malformed markup should always yield the best possible text without
// throwing.
//
// This module performs NO network work, registers NO tool, and adds NO
// untrusted-content boundary (that belongs to a later step). It only turns a
// remote string into a readable remote string. Never log its output: it can
// contain arbitrary fetched page bodies.

/**
 * Maximum normalized/extracted model content. The truncation marker counts
 * towards this bound (see {@link truncateExtractedContent}), so the returned
 * `text` never exceeds it. This is a pre-context safety bound only; the
 * context budget (Step 42) is the final authority and normally truncates far
 * more.
 */
export const MAX_EXTRACTED_CONTENT_CHARACTERS = 200_000;

/** Conservative maximum length for an extracted page title. */
export const MAX_TITLE_CHARACTERS = 300;

/**
 * Marker appended when the extraction cap is hit. Included in the declared
 * character bound, so it is subtracted from the available body length first.
 */
const TRUNCATION_MARKER = "\n\n[content truncated by fetch_url extraction limit]";

/**
 * Named entities decoded by this step. Deliberately limited to the required
 * set plus the trivially useful `&nbsp;`/`&apos;`. Unknown named entities are
 * left literally in the text rather than guessed.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Matches a supported numeric entity (`&#123;` / `&#x1F600;`) or any named one.
 * The single capturing group holds the entity body without the leading `&`, so
 * a leading `#` means numeric and anything else is a named entity.
 */
const ENTITY_RE = /&(#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Closing tags whose boundary should become a paragraph break. */
const BLOCK_TAGS =
  "p|div|h[1-6]|ul|ol|li|tr|td|th|table|blockquote|pre|section|article|header|footer|nav|aside|main|figure|figcaption|dl|dt|dd";

export interface FetchUrlContentInput {
  /** Final URL after redirects (Step 48). Kept for a uniform input contract. */
  url: string;
  /** Media type already normalized by the network client (may carry `;charset`). */
  contentType: string;
  /** Bounded downloaded body (<= 1 MB). */
  content: string;
}

export interface FetchUrlContentResult {
  /** Extracted page title, or undefined when there is none. */
  title?: string;
  /** Normalized, readable body. Empty string means no readable content. */
  text: string;
}

/**
 * Classify a media type into one of the extraction strategies.
 *
 * `application/xhtml+xml` is routed to HTML before the generic `+xml` branch so
 * it is not treated as XML. Anything textual that is not clearly one of the
 * known kinds falls back to plain-text normalization.
 */
function classifyContentType(contentType: string): "html" | "json" | "xml" | "text" {
  const mediaType = contentType.split(";")[0].trim().toLowerCase();

  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return "html";
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return "json";
  }
  if (mediaType === "application/xml" || mediaType === "text/xml" || mediaType.endsWith("+xml")) {
    return "xml";
  }
  return "text";
}

export function extractFetchUrlContent(input: FetchUrlContentInput): FetchUrlContentResult {
  const { contentType, content } = input;
  const kind = classifyContentType(contentType);

  let title: string | undefined;
  let body: string;

  switch (kind) {
    case "html": {
      const extracted = extractHtmlContent(content);
      title = extracted.title;
      body = extracted.text;
      break;
    }
    case "json":
      body = prettyPrintOrNormalizeJson(content);
      break;
    case "xml":
      body = extractXmlContent(content);
      break;
    default:
      body = normalizeReadableText(content);
      break;
  }

  body = truncateExtractedContent(body);

  const result: FetchUrlContentResult = { text: body };
  if (title !== undefined && title.length > 0) {
    result.title = title;
  }
  return result;
}

/**
 * HTML/XHTML extraction: capture the title, drop comments and non-readable
 * blocks, turn obvious block separators into newlines, strip the remaining
 * tags, decode supported entities, then normalize. Malformed input yields the
 * best possible text and never throws.
 */
function extractHtmlContent(content: string): { title: string | undefined; text: string } {
  const title = extractHtmlTitle(content);

  let body = content;
  body = removeHtmlComments(body);
  body = removeNonReadableBlocks(body);
  body = convertBlockSeparators(body);
  body = stripHtmlTags(body);
  body = decodeSupportedEntities(body);
  body = normalizeReadableText(body);

  return { title, text: body };
}

/** Capture and normalize a `<title>` value before any tag stripping. */
function extractHtmlTitle(content: string): string | undefined {
  const match = /<title\b[\s\S]*?>([\s\S]*?)<\/title>/i.exec(content);
  if (!match) {
    return undefined;
  }

  let title = stripHtmlTags(match[1]);
  title = decodeSupportedEntities(title);
  title = normalizeReadableText(title);

  if (title.length === 0) {
    return undefined;
  }
  return truncateSurrogateSafe(title, MAX_TITLE_CHARACTERS);
}

function removeHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, " ");
}

/** Remove complete non-readable blocks (script/style/noscript/svg, etc.). */
function removeNonReadableBlocks(content: string): string {
  return content
    .replace(/<title\b[\s\S]*?<\/title>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
}

/** Turn `<br>`/`<hr>` and closing block tags into newlines for separation. */
function convertBlockSeparators(content: string): string {
  let body = content.replace(/<br\s*\/?>/gi, "\n").replace(/<hr\s*\/?>/gi, "\n");
  body = body.replace(new RegExp(`</(${BLOCK_TAGS})\\s*>`, "gi"), "\n");
  return body;
}

function stripHtmlTags(content: string): string {
  return content.replace(/<[^>]*>/g, "");
}

/**
 * Decode the supported named and numeric entities. Invalid numeric entities,
 * isolated surrogates, out-of-range code points, and unknown named entities are
 * left untouched rather than crashing the harness.
 */
function decodeSupportedEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith("#")) {
      // Numeric entity: `&#123;` or `&#x1F600;`.
      const rest = body.slice(1);
      const isHex = rest[0] === "x" || rest[0] === "X";
      const digits = isHex ? rest.slice(1) : rest;
      const value = Number.parseInt(digits, isHex ? 16 : 10);
      if (Number.isNaN(value)) {
        return match;
      }
      // Reject out-of-range code points and isolated surrogates.
      if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(value);
    }

    // Named entity: only the small required set is decoded; unknown ones stay.
    const mapped = NAMED_ENTITIES[body.toLowerCase()];
    return mapped !== undefined ? mapped : match;
  });
}

/**
 * JSON: pretty-print when valid, otherwise fall back to deterministically
 * normalized raw text. A malformed body is never a tool failure here.
 */
function prettyPrintOrNormalizeJson(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return normalizeReadableText(content);
  }
}

const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";

/**
 * Conservative XML/text normalization without an XML parser: drop comments and
 * processing instructions, turn closing element tags into newlines, strip the
 * remaining markup, decode basic entities, then normalize. External entities are
 * never resolved (pure string processing cannot, and must not, do so).
 */
function extractXmlContent(content: string): string {
  const segments = content.split(/(<!\[CDATA\[[\s\S]*?\]\>)/g);
  const body = segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        // Captured CDATA section: keep its body verbatim.
        return segment.slice(CDATA_OPEN.length, -CDATA_CLOSE.length);
      }
      let text = segment;
      text = text.replace(/<!--[\s\S]*?-->/g, " ");
      text = text.replace(/<\?[\s\S]*?\?>/g, " ");
      text = text.replace(/<![^\s\S]*?>/g, " ");
      text = text.replace(new RegExp(`</[^\s>][^>]*>`, "gi"), "\n");
      text = stripHtmlTags(text);
      return decodeSupportedEntities(text);
    })
    .join("");
  return normalizeReadableText(body);
}

/**
 * Deterministic, shared normalization for HTML/text/XML:
 * CRLF/CR -> LF, drop NUL and other control characters, strip trailing
 * whitespace per line, collapse blank-line runs to a single blank paragraph,
 * and trim. Tabs and newlines are preserved so paragraph structure survives.
 */
function normalizeReadableText(text: string): string {
  let body = text
    // Remove NUL and other control characters (keep \t and \n).
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    // Normalize line endings to LF.
    .replace(/\r\n?/g, "\n")
    // Drop trailing spaces/tabs at the end of each line.
    .replace(/[ \t]+$/gm, "");

  // Collapse three or more line breaks into one blank paragraph.
  body = body.replace(/\n{3,}/g, "\n\n");

  return body.trim();
}

/**
 * Cap the extracted body at {@link MAX_EXTRACTED_CONTENT_CHARACTERS}. The
 * marker is subtracted from the available length first, so the final string
 * never exceeds the declared bound, and the cut is surrogate-safe.
 */
function truncateExtractedContent(text: string): string {
  if (text.length <= MAX_EXTRACTED_CONTENT_CHARACTERS) {
    return text;
  }
  const maxBodyLength = MAX_EXTRACTED_CONTENT_CHARACTERS - TRUNCATION_MARKER.length;
  return truncateSurrogateSafe(text, maxBodyLength) + TRUNCATION_MARKER;
}

/**
 * Truncate to `maxCodeUnits` code units, dropping a dangling high surrogate so
 * a cut never splits a UTF-16 surrogate pair.
 */
function truncateSurrogateSafe(text: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0) {
    return "";
  }
  let result = text.slice(0, maxCodeUnits);
  const lastCodeUnit = result.charCodeAt(result.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    // Dangling high surrogate at the cut: drop it. A trailing low surrogate
    // (0xdc00-0xdfff) completes a pair and must be preserved.
    result = result.slice(0, -1);
  }
  return result;
}
