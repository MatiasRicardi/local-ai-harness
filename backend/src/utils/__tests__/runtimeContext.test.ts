import { describe, it, expect } from "vitest";
import { buildRuntimeContextMessage } from "../runtimeContext.js";

// A fixed instant chosen so the user's local date differs from the UTC date,
// exercising every field (UTC date 2026-10-02 vs Montevideo local 2026-10-01).
const INSTANT = "2026-10-02T01:30:00.000Z";

describe("buildRuntimeContextMessage", () => {
  it("builds the full six-field message for a valid timezone and locale", () => {
    const message = buildRuntimeContextMessage(
      { timeZone: "America/Montevideo", locale: "es-UY" },
      new Date(INSTANT),
    );

    expect(message.role).toBe("system");
    expect(message.content).toBe(
      [
        "Current runtime context:",
        "- UTC timestamp: 2026-10-02T01:30:00.000Z",
        "- User local date/time: 2026-10-01 22:30:00",
        "- User timezone: America/Montevideo",
        "- UTC offset: -03:00",
        "- Weekday: Thursday",
        "- User locale: es-UY",
      ].join("\n"),
    );
  });

  it("formats UTC as ISO 8601 with Z and local as YYYY-MM-DD HH:MM:SS", () => {
    const message = buildRuntimeContextMessage(
      { timeZone: "America/Montevideo", locale: "es-UY" },
      new Date(INSTANT),
    );

    expect(message.content).toMatch(/- UTC timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(message.content).toMatch(/- User local date\/time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it("computes the offset as ±HH:MM and keeps the weekday in English regardless of locale", () => {
    const message = buildRuntimeContextMessage(
      { timeZone: "America/Montevideo", locale: "es-UY" },
      new Date(INSTANT),
    );

    expect(message.content).toMatch(/- UTC offset: -\d{2}:\d{2}/);
    // Weekday stays English even though the locale is Spanish.
    expect(message.content).toMatch(/- Weekday: Thursday/);
    expect(message.content).not.toMatch(/- Weekday: jueves/);
  });

  it("derives the local date and weekday from the user's timezone, not UTC", () => {
    // UTC date is 2026-10-02 (Friday); Montevideo (-03) is still 2026-10-01
    // (Thursday). The model must know the user's real local day.
    const message = buildRuntimeContextMessage(
      { timeZone: "America/Montevideo", locale: "es-UY" },
      new Date(INSTANT),
    );

    expect(message.content).toContain("- User local date/time: 2026-10-01 22:30:00");
    expect(message.content).toContain("- Weekday: Thursday");
  });

  it("handles DST with the correct summer and winter offsets", () => {
    const summer = buildRuntimeContextMessage(
      { timeZone: "America/New_York", locale: "en-US" },
      new Date("2026-07-15T12:00:00.000Z"),
    );
    const winter = buildRuntimeContextMessage(
      { timeZone: "America/New_York", locale: "en-US" },
      new Date("2026-01-15T12:00:00.000Z"),
    );

    expect(summer.content).toContain("- UTC offset: -04:00");
    expect(winter.content).toContain("- UTC offset: -05:00");
  });

  it("handles half-hour and 45-minute offsets", () => {
    const kolkata = buildRuntimeContextMessage(
      { timeZone: "Asia/Kolkata", locale: "en-IN" },
      new Date(INSTANT),
    );
    const kathmandu = buildRuntimeContextMessage(
      { timeZone: "Asia/Kathmandu", locale: "en-NP" },
      new Date(INSTANT),
    );

    expect(kolkata.content).toContain("- UTC offset: +05:30");
    expect(kathmandu.content).toContain("- UTC offset: +05:45");
  });

  it("reports the true offset for zones east of +12:00, past the Pacific date line", () => {
    // Kiritimati (+14:00): at 2024-01-01T10:00:00Z the local wall clock is
    // 2024-01-02 00:00. Reading only hour/minute would fold this to -10:00;
    // the day rollover must be preserved as +14:00.
    const kiritimati = buildRuntimeContextMessage(
      { timeZone: "Pacific/Kiritimati", locale: "en-US" },
      new Date("2024-01-01T10:00:00.000Z"),
    );
    expect(kiritimati.content).toContain("- UTC offset: +14:00");
    expect(kiritimati.content).toContain("- User local date/time: 2024-01-02 00:00:00");

    // Tongatapu (+13:00) and Chatham (+13:45 during DST) stay ahead of +12:00.
    const tongatapu = buildRuntimeContextMessage(
      { timeZone: "Pacific/Tongatapu", locale: "en-US" },
      new Date("2024-01-01T10:00:00.000Z"),
    );
    expect(tongatapu.content).toContain("- UTC offset: +13:00");

    const chatham = buildRuntimeContextMessage(
      { timeZone: "Pacific/Chatham", locale: "en-NZ" },
      new Date("2024-01-01T10:00:00.000Z"),
    );
    expect(chatham.content).toContain("- UTC offset: +13:45");
  });

  it("reflects the injected clock in the UTC timestamp", () => {
    const a = buildRuntimeContextMessage(
      { timeZone: "America/Montevideo", locale: "es-UY" },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const b = buildRuntimeContextMessage(
      { timeZone: "America/Montevideo", locale: "es-UY" },
      new Date("2027-06-30T23:59:59.000Z"),
    );

    expect(a.content).toContain("- UTC timestamp: 2026-01-01T00:00:00.000Z");
    expect(b.content).toContain("- UTC timestamp: 2027-06-30T23:59:59.000Z");
    expect(a.content).not.toEqual(b.content);
  });

  it("uses the backend clock by default (now = new Date())", () => {
    const before = Date.now();
    const message = buildRuntimeContextMessage({
      timeZone: "America/Montevideo",
      locale: "es-UY",
    });
    const after = Date.now();

    const ts = message.content.match(/- UTC timestamp: (\S+)/)?.[1];
    expect(ts).toBeTruthy();
    const parsed = Date.parse(ts!);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  describe("runtime context omitted or blank", () => {
    it("sends a UTC-only message when runtimeContext is undefined", () => {
      const message = buildRuntimeContextMessage(undefined, new Date(INSTANT));

      expect(message.role).toBe("system");
      expect(message.content).toContain("Current runtime context:");
      expect(message.content).toContain("- UTC timestamp: 2026-10-02T01:30:00.000Z");
      expect(message.content).toContain(
        "User local timezone and local date/time are unavailable.",
      );
      expect(message.content).not.toContain("User timezone:");
      expect(message.content).not.toContain("User local date/time:");
    });

    it("sends a UTC-only message when the locale is blank", () => {
      const message = buildRuntimeContextMessage(
        { timeZone: "America/Montevideo", locale: "" },
        new Date(INSTANT),
      );

      expect(message.content).toContain(
        "User local timezone and local date/time are unavailable.",
      );
      expect(message.content).not.toContain("User timezone:");
    });

    it("sends a UTC-only message when the timezone is blank", () => {
      const message = buildRuntimeContextMessage(
        { timeZone: "", locale: "es-UY" },
        new Date(INSTANT),
      );

      expect(message.content).toContain(
        "User local timezone and local date/time are unavailable.",
      );
      expect(message.content).not.toContain("User timezone:");
    });
  });
});
