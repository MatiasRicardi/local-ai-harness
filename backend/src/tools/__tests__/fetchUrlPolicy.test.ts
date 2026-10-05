import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LookupAddress } from "node:dns";
import {
  validateFetchUrlTarget,
  FetchUrlPolicyError,
  type ValidatedFetchUrlTarget,
} from "../fetchUrlPolicy.js";

// Type the mock against the overload the policy actually calls ({ all: true }),
// so mockResolvedValueOnce accepts every resolved address.
const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn<
    (host: string, options: { all: true; verbatim: true }) => LookupAddress[]
  >(),
}));

// Keep the real node:dns/promises module intact and only replace `lookup`, so
// the rest of the module behaves for real. (vi.spyOn cannot be used on a Node
// builtin namespace: ESM module namespaces are not configurable.)
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: lookupMock };
});

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

const lookupSpy = lookupMock;

/** Make DNS resolve the given addresses (family inferred from the literal). */
function mockDns(...addresses: string[]) {
  lookupSpy.mockResolvedValueOnce(
    addresses.map((address): LookupAddress => ({
      address,
      family: address.includes(":") ? 2 : 1,
    })),
  );
}

beforeEach(() => {
  lookupSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateFetchUrlTarget — happy path", () => {
  it("allows a public hostname resolving to a single public IPv4", async () => {
    mockDns(PUBLIC_V4);

    const target = await validateFetchUrlTarget("http://example.com/");

    expect(target).toMatchObject({
      url: "http://example.com/",
      hostname: "example.com",
      addresses: [PUBLIC_V4],
    } satisfies ValidatedFetchUrlTarget);
  });

  it("allows a public hostname resolving to public IPv4 and IPv6", async () => {
    mockDns(PUBLIC_V4, PUBLIC_V6);

    const target = await validateFetchUrlTarget("https://example.com/path");

    expect(target).toMatchObject({
      url: "https://example.com/path",
      hostname: "example.com",
      addresses: [PUBLIC_V4, PUBLIC_V6],
    });
  });

  it("preserves an allowed non-default port for a public destination", async () => {
    mockDns(PUBLIC_V4);

    const target = await validateFetchUrlTarget("https://example.com:8443/");

    expect(target.url).toBe("https://example.com:8443/");
  });
});

describe("validateFetchUrlTarget — URL syntax & protocol policy", () => {
  it("rejects a malformed URL", async () => {
    await expect(validateFetchUrlTarget("not a url")).rejects.toBeInstanceOf(
      FetchUrlPolicyError,
    );
    await expect(validateFetchUrlTarget("not a url")).rejects.toMatchObject({
      errorType: "INVALID_URL",
    });
  });

  it("rejects unsupported protocols", async () => {
    for (const scheme of ["file", "ftp", "data", "javascript", "ws", "wss"]) {
      await expect(validateFetchUrlTarget(`${scheme}://example.com/`)).rejects.toMatchObject(
        { errorType: "UNSUPPORTED_PROTOCOL" },
      );
    }
  });

  it("rejects URLs carrying credentials", async () => {
    await expect(
      validateFetchUrlTarget("http://user:pass@example.com/"),
    ).rejects.toMatchObject({ errorType: "URL_CREDENTIALS_NOT_ALLOWED" });
  });
});

describe("validateFetchUrlTarget — localhost policy", () => {
  it("rejects the literal localhost name", async () => {
    await expect(validateFetchUrlTarget("http://localhost/")).rejects.toMatchObject({
      errorType: "LOCALHOST_NOT_ALLOWED",
    });
  });

  it("rejects localhost with a trailing dot", async () => {
    await expect(validateFetchUrlTarget("http://localhost./")).rejects.toMatchObject({
      errorType: "LOCALHOST_NOT_ALLOWED",
    });
  });

  it("rejects localhost subdomains (with or without trailing dot)", async () => {
    for (const host of ["foo.localhost", "foo.localhost.", "a.b.localhost."]) {
      await expect(validateFetchUrlTarget(`http://${host}/`)).rejects.toMatchObject({
        errorType: "LOCALHOST_NOT_ALLOWED",
      });
    }
  });

  it("rejects an uppercase localhost name", async () => {
    await expect(validateFetchUrlTarget("http://LOCALHOST/")).rejects.toMatchObject({
      errorType: "LOCALHOST_NOT_ALLOWED",
    });
  });

  it("rejects localhost even when it would resolve to a public address", async () => {
    mockDns(PUBLIC_V4);

    await expect(validateFetchUrlTarget("http://localhost/")).rejects.toMatchObject({
      errorType: "LOCALHOST_NOT_ALLOWED",
    });
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});

describe("validateFetchUrlTarget — IP literal classification (no DNS)", () => {
  it("allows a public IPv4 literal without calling DNS", async () => {
    const target = await validateFetchUrlTarget("http://93.184.216.34/");

    expect(target.addresses).toEqual([PUBLIC_V4]);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("allows a public IPv6 literal without calling DNS", async () => {
    const target = await validateFetchUrlTarget(`http://[${PUBLIC_V6}]/`);

    expect(target.addresses).toEqual([PUBLIC_V6]);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["127.0.0.1", "loopback IPv4"],
    ["127.1", "loopback IPv4 (WHATWG-normalized)"],
    ["0.0.0.0", "unspecified IPv4"],
    ["10.0.0.5", "private IPv4"],
    ["172.16.0.1", "private IPv4"],
    ["172.31.255.255", "private IPv4 edge"],
    ["192.168.1.1", "private IPv4"],
    ["169.254.169.254", "link-local (cloud metadata)"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["192.0.2.1", "documentation TEST-NET-1"],
    ["198.51.100.1", "documentation TEST-NET-2"],
    ["203.0.113.1", "documentation TEST-NET-3"],
    ["224.0.0.1", "multicast IPv4"],
    ["240.0.0.1", "reserved IPv4"],
    ["[::1]", "loopback IPv6"],
    ["[::]", "unspecified IPv6"],
    ["[fd00::1]", "unique-local IPv6"],
    ["[fc00::1]", "unique-local IPv6"],
    ["[fe80::1]", "link-local IPv6"],
    ["[ff00::1]", "multicast IPv6"],
    ["[::ffff:10.0.0.1]", "IPv4-mapped private"],
    ["[::ffff:127.0.0.1]", "IPv4-mapped loopback"],
  ])("rejects %s (%s)", async (host) => {
    await expect(validateFetchUrlTarget(`http://${host}/`)).rejects.toMatchObject({
      errorType: "NON_PUBLIC_ADDRESS",
    });
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});

describe("validateFetchUrlTarget — DNS resolution classification", () => {
  it("allows a public hostname", async () => {
    mockDns(PUBLIC_V4);
    await expect(validateFetchUrlTarget("http://example.com/")).resolves.toBeTruthy();
  });

  it("rejects a hostname resolving only to a private IPv4", async () => {
    mockDns("10.0.0.5");
    await expect(validateFetchUrlTarget("http://example.com/")).rejects.toMatchObject({
      errorType: "NON_PUBLIC_ADDRESS",
    });
  });

  it("rejects a hostname resolving to public + private IPv4", async () => {
    mockDns(PUBLIC_V4, "127.0.0.1");
    await expect(validateFetchUrlTarget("http://example.com/")).rejects.toMatchObject({
      errorType: "NON_PUBLIC_ADDRESS",
    });
  });

  it("rejects a hostname resolving to public IPv4 + private IPv6", async () => {
    mockDns(PUBLIC_V4, "fd00::1");
    await expect(validateFetchUrlTarget("http://example.com/")).rejects.toMatchObject({
      errorType: "NON_PUBLIC_ADDRESS",
    });
  });

  it("rejects a hostname resolving to public IPv6 + private IPv4", async () => {
    mockDns(PUBLIC_V6, "192.168.1.1");
    await expect(validateFetchUrlTarget("http://example.com/")).rejects.toMatchObject({
      errorType: "NON_PUBLIC_ADDRESS",
    });
  });

  it("rejects when DNS returns no addresses", async () => {
    lookupSpy.mockResolvedValueOnce([] as LookupAddress[]);
    await expect(validateFetchUrlTarget("http://example.com/")).rejects.toMatchObject({
      errorType: "DNS_RESOLUTION_FAILED",
    });
  });

  it("rejects (safely) when DNS throws, without leaking the raw error", async () => {
    lookupSpy.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND example.com"));

    await expect(validateFetchUrlTarget("http://example.com/")).rejects.toMatchObject({
      errorType: "DNS_RESOLUTION_FAILED",
    });
    await expect(validateFetchUrlTarget("http://example.com/")).rejects.not.toThrow(
      /ENOTFOUND/,
    );
  });
});

describe("validateFetchUrlTarget — error contract", () => {
  it("throws FetchUrlPolicyError with a controlled message for every failure", async () => {
    for (const check of [
      () => validateFetchUrlTarget("nope"),
      () => validateFetchUrlTarget("file:///etc/passwd"),
      () => validateFetchUrlTarget("http://user:pass@example.com/"),
      () => validateFetchUrlTarget("http://localhost/"),
      () => validateFetchUrlTarget("http://127.0.0.1/"),
    ]) {
      let error: unknown;
      try {
        await check();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(FetchUrlPolicyError);
      // Messages are stable and never contain raw DNS diagnostics or internal
      // addresses (which could reach the model).
      expect((error as Error).message).not.toMatch(/127\.0\.0\.1|ENOTFOUND|::ffff|fd00/);
    }
  });
});
