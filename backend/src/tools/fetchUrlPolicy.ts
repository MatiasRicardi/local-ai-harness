import * as dnsPromises from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

// ── Fetch URL destination policy (SSRF / public-network guard) ────────────────
//
// Validates ONLY where a model-driven `fetch_url` call may connect: URL parsing,
// DNS resolution and address classification. Returns normalized, safe destination
// info. It does NOT perform any HTTP work (no fetch, redirects or body) — that
// belongs to a later step.
//
// `fetch_url` runs on the user's local machine / home network, so SSRF protection
// is a release blocker. The policy is deliberately conservative: if ANY resolved
// address is not on public routable internet space, the whole destination is
// rejected, so an attacker cannot rely on a safe answer while the HTTP stack
// later connects to a different, unsafe one.
//
// DNS REBINDING LIMITATION (documented on purpose):
//   This validates every address resolved at validation time, but does NOT pin
//   the subsequent network connection to those addresses. A DNS record can change
//   between validation and connection (TOCTOU), so a hostname resolving publicly
//   here may resolve privately at connect time. Re-validating redirects (a later
//   step) addresses a different problem (a public URL redirecting to a private
//   one) and does NOT eliminate DNS rebinding. Connection pinning, if any, must
//   be decided where the transport lives — not here, since there is no HTTP yet.
//
// Decoupled from the harness HTTP/error layer: throws a typed
// {@link FetchUrlPolicyError}. Mapping that onto an AppError / SSE / tool error
// is done in the integration step, not here.

/**
 * Normalized, validated destination returned by {@link validateFetchUrlTarget}.
 *
 * - `url`: the canonical URL after parsing.
 * - `hostname`: the normalized hostname used for validation.
 * - `addresses`: every resolved address, all verified public. Never exposed to
 *   the model or the API.
 */
export interface ValidatedFetchUrlTarget {
  url: string;
  hostname: string;
  addresses: readonly string[];
}

/**
 * Stable machine-readable rejection reasons. Kept small and transport-agnostic
 * so later steps can map them without guessing.
 */
export type FetchUrlPolicyErrorType =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "URL_CREDENTIALS_NOT_ALLOWED"
  | "LOCALHOST_NOT_ALLOWED"
  | "DNS_RESOLUTION_FAILED"
  | "NON_PUBLIC_ADDRESS";

/**
 * Policy rejection.
 *
 * Carries a stable {@link FetchUrlPolicyErrorType} and a controlled, safe
 * message. Raw DNS diagnostics, stack traces and internal addresses are never
 * placed in the message, so they cannot leak to the model. The underlying cause
 * (e.g. a DNS error) is retained internally on `cause` only.
 */
export class FetchUrlPolicyError extends Error {
  readonly errorType: FetchUrlPolicyErrorType;

  constructor(message: string, errorType: FetchUrlPolicyErrorType, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "FetchUrlPolicyError";
    this.errorType = errorType;
  }
}

/**
 * Validate a raw URL and resolve/classify its destination.
 *
 * Flow: parse URL → protocol allowlist → credentials policy → hostname
 * normalization → localhost policy → literal-IP or DNS resolution → validate
 * every resolved address is public. Throws {@link FetchUrlPolicyError} on any
 * failure; never exposes raw diagnostics.
 */
export async function validateFetchUrlTarget(
  rawUrl: string,
): Promise<ValidatedFetchUrlTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchUrlPolicyError("The provided URL is not valid.", "INVALID_URL");
  }

  // Protocol allowlist: only http/https. URL lowercases the protocol already.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchUrlPolicyError(
      "The URL protocol is not supported.",
      "UNSUPPORTED_PROTOCOL",
    );
  }

  // Credentials are never allowed; we do not silently strip them and continue.
  if (url.username !== "" || url.password !== "") {
    throw new FetchUrlPolicyError(
      "URL credentials are not allowed.",
      "URL_CREDENTIALS_NOT_ALLOWED",
    );
  }

  const hostname = normalizeHostname(url.hostname);

  if (hostname === "") {
    throw new FetchUrlPolicyError("The URL does not contain a valid host.", "INVALID_URL");
  }

  // Defense-in-depth: reject obvious local destinations by name, independent of
  // whether DNS would later resolve them to a loopback address.
  if (isBlockedLocalHost(hostname)) {
    throw new FetchUrlPolicyError(
      "Localhost destinations are not allowed.",
      "LOCALHOST_NOT_ALLOWED",
    );
  }

  const addresses = await resolveAddresses(hostname);

  // Conservative: reject the whole destination if any address is non-public.
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new FetchUrlPolicyError(
        "The destination is not on a public network.",
        "NON_PUBLIC_ADDRESS",
      );
    }
  }

  return {
    url: url.toString(),
    hostname,
    addresses: addresses.slice(),
  };
}

// ── Hostname helpers ──────────────────────────────────────────────────────────

/**
 * Normalize a hostname for the localhost policy: trim, lowercase (WHATWG URL
 * already does this, but keep it explicit) and strip a single trailing dot so
 * `localhost.` and `foo.localhost.` are recognized.
 */
function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Block `localhost` and any `*.localhost` subdomain (after normalization).
 */
function isBlockedLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

// ── Resolution helpers ────────────────────────────────────────────────────────

/**
 * Resolve a hostname to every address the machine could use, or classify an IP
 * literal directly (no DNS).
 */
async function resolveAddresses(hostname: string): Promise<string[]> {
  const literal = stripBrackets(hostname);
  if (isIPv4(literal) || isIPv6(literal)) {
    // IP literal: no DNS lookup, classify the literal itself.
    return [literal];
  }

  let results: Array<{ address: string; family: number }>;
  try {
    // `all: true` returns every IPv4 and IPv6 answer; `verbatim: true` keeps the
    // original textual form so classification sees what the stack would use.
    results = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    // Never leak the underlying DNS error to the caller/model.
    throw new FetchUrlPolicyError(
      "The destination hostname could not be resolved.",
      "DNS_RESOLUTION_FAILED",
    );
  }

  if (results.length === 0) {
    throw new FetchUrlPolicyError(
      "The destination hostname did not resolve to any address.",
      "DNS_RESOLUTION_FAILED",
    );
  }

  return results.map((result) => result.address);
}

/**
 * WHATWG `URL.hostname` keeps brackets around IPv6 literals (`[::1]`); strip
 * them before classifying so `net.isIPv6` accepts the literal.
 */
function stripBrackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Classify an address as public. Fail closed on any unparseable form. IPv4-
 * mapped/compatible IPv6 (e.g. `::ffff:10.0.0.1`) is validated as the embedded
 * IPv4 so it cannot bypass the IPv4 policy.
 */
function isPublicAddress(address: string): boolean {
  const candidate = stripBrackets(address.trim());
  if (isIPv4(candidate)) {
    return isPublicIPv4(candidate);
  }
  if (isIPv6(candidate)) {
    // IPv4-mapped/compatible forms are validated as the embedded IPv4 so they
    // cannot bypass the IPv4 policy.
    if (isMappedIPv6(candidate)) {
      return isPublicMappedIPv6(candidate);
    }
    return isPublicIPv6(candidate);
  }
  return false;
}

// ── IPv4 classification ───────────────────────────────────────────────────────

/**
 * Parse an IPv4 literal into an unsigned 32-bit integer, or null if it is not a
 * well-formed dotted-quad (fail closed on malformed input).
 */
function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * True when the IPv4 integer is on a globally routable public network. Every
 * non-public range below fails closed (returns false).
 */
function isPublicIPv4(ip: string): boolean {
  const value = parseIPv4(ip);
  if (value === null) return false;
  return isPublicIPv4Number(value);
}

function isPublicIPv4Number(value: number): boolean {
  const a = (value >> 24) & 0xff;
  const b = (value >> 16) & 0xff;
  const c = (value >> 8) & 0xff;

  // 0.0.0.0/8 — unspecified / "this host"
  if (a === 0) return false;
  // 10.0.0.0/8 — private
  if (a === 10) return false;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && (b & 0xc0) === 0x40) return false;
  // 127.0.0.0/8 — loopback
  if (a === 127) return false;
  // 169.254.0.0/16 — link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12 — private
  if (a === 172 && (b & 0xf0) === 0x10) return false;
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && c === 0) return false;
  // 192.0.2.0/24 — documentation (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return false;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return false;
  // 198.18.0.0/15 — network benchmarking
  if (a === 198 && (b & 0xfe) === 18) return false;
  // 198.51.100.0/24 — documentation (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return false;
  // 203.0.113.0/24 — documentation (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return false;
  // 224.0.0.0/4 — multicast
  if ((a & 0xf0) === 0xe0) return false;
  // 240.0.0.0/4 — reserved / future use / broadcast
  if ((a & 0xf0) === 0xf0) return false;

  return true;
}

// ── IPv6 classification ───────────────────────────────────────────────────────

/**
 * Expand an IPv6 literal (with optional embedded IPv4) into a 128-bit integer,
 * or null if it is not well-formed (fail closed on malformed input).
 */
function expandIPv6(ip: string): bigint | null {
  let s = ip.trim();

  // Drop link-local zone id (e.g. fe80::1%eth0).
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);

  // At most one `::` compression allowed.
  if (s.indexOf("::") !== s.lastIndexOf("::")) return null;

  let left = s;
  let right: string | null = null;
  const dc = s.indexOf("::");
  if (dc !== -1) {
    left = s.slice(0, dc);
    right = s.slice(dc + 2);
  }

  const splitPart = (part: string): string[] => (part === "" ? [] : part.split(":"));
  let leftGroups: string[] | null = splitPart(left);
  let rightGroups: string[] | null = right === null ? [] : splitPart(right);

  // Convert any embedded IPv4 group (contains a dot) into two 16-bit hex groups.
  const convertEmbeddedIPv4 = (groups: string[]): string[] | null => {
    const out: string[] = [];
    for (const g of groups) {
      if (g.includes(".")) {
        const v = parseIPv4(g);
        if (v === null) return null;
        out.push(((v >> 16) & 0xffff).toString(16));
        out.push((v & 0xffff).toString(16));
      } else {
        out.push(g);
      }
    }
    return out;
  };

  leftGroups = convertEmbeddedIPv4(leftGroups);
  if (leftGroups === null) return null;
  if (rightGroups !== null) {
    rightGroups = convertEmbeddedIPv4(rightGroups);
    if (rightGroups === null) return null;
  }
  // If we reach here without returning, both sides are concrete group lists.
  if (rightGroups === null) return null;

  const explicitCount = leftGroups.length + rightGroups.length;
  let fullGroups: string[];
  if (right === null) {
    fullGroups = [...leftGroups];
  } else {
    const fill = 8 - explicitCount;
    if (fill < 1) return null; // `::` must represent at least one group
    const zeros = Array.from({ length: fill }, () => "0");
    fullGroups = [...leftGroups, ...zeros, ...rightGroups];
  }

  if (fullGroups.length !== 8) return null;

  let value = 0n;
  for (const g of fullGroups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/**
 * True when the IPv6 literal is IPv4-mapped (`::ffff:x`) or IPv4-compatible
 * (`::x`): its top 96 bits are all zero, or the top 80 are zero with the next
 * 16 bits all one. Such forms must be validated as the embedded IPv4.
 */
function isMappedIPv6(ip: string): boolean {
  const value = expandIPv6(ip);
  if (value === null) return false;
  const top96 = value >> 32n;
  return top96 === 0xffffn || top96 === 0n;
}

/**
 * True when the IPv6 literal is globally routable.
 *
 * Uses real bit-range parsing rather than string prefixes:
 * - IPv4-mapped (`::ffff:x`) and IPv4-compatible (`::x`) are validated as the
 *   embedded IPv4 so they cannot bypass the IPv4 policy.
 * - The global unicast space `2000::/3` (top 3 bits == 001) is the single
 *   source of "public"; everything else fails closed. This inherently blocks
 *   the required ranges: `::` / `::1`, unique-local `fc00::/7`, link-local
 *   `fe80::/10` and multicast `ff00::/8`.
 */
function isPublicIPv6(ip: string): boolean {
  const value = expandIPv6(ip);
  if (value === null) return false;

  // 2001:db8::/32 is reserved for documentation (RFC 3849), not global routing.
  // Its top 32 bits are exactly 0x20010db8; check it before the 2000::/3 check.
  if ((value >> 96n) === 0x20010db8n) return false;

  // IPv4-mapped/compatible forms are handled upstream (isPublicMappedIPv6).
  // Global unicast 2000::/3 (top 3 bits == 001 == 1); everything else fails
  // closed, which inherently blocks ::, ::1, fc00::/7, fe80::/10, ff00::/8.
  return (value >> 125n) === 1n;
}

/**
 * Validate the 32-bit IPv4 embedded in an IPv4-mapped/compatible IPv6 literal.
 * The value fits in a JS number, so convert before reusing the IPv4 policy.
 */
function isPublicMappedIPv6(ip: string): boolean {
  const value = expandIPv6(ip);
  if (value === null) return false;
  const top96 = value >> 32n;
  if (top96 !== 0xffffn && top96 !== 0n) return false;
  return isPublicIPv4Number(Number(value & 0xffffffffn));
}
