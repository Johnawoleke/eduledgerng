import { describe, it, expect } from "vitest";
import { buildFutureSessions, isFutureSessionId, FUTURE_SESSION_COUNT } from "./useAcademicPeriods";

describe("buildFutureSessions", () => {
  it("generates 10 sessions after the latest real session", () => {
    const future = buildFutureSessions(
      [{ name: "2026/2027", start_year: 2026, end_year: 2027 }],
      2026
    );
    expect(future).toHaveLength(FUTURE_SESSION_COUNT);
    expect(future[0]).toMatchObject({ id: "future-2027", name: "2027/2028", isFuture: true });
    expect(future[9]).toMatchObject({ id: "future-2036", name: "2036/2037", isFuture: true });
  });

  it("starts from the current year when there are no real sessions", () => {
    const future = buildFutureSessions([], 2026);
    expect(future[0].name).toBe("2026/2027");
    expect(future).toHaveLength(FUTURE_SESSION_COUNT);
  });

  it("uses the LATEST session even when several exist (qwert has 11)", () => {
    const sessions = Array.from({ length: 11 }, (_, i) => ({
      name: `${2025 + i}/${2026 + i}`,
      start_year: 2025 + i,
      end_year: 2026 + i,
    }));
    const future = buildFutureSessions(sessions, 2026);
    expect(future[0].name).toBe("2036/2037");
  });

  it("falls back to parsing the name when year columns are null", () => {
    const future = buildFutureSessions(
      [{ name: "2028/2029", start_year: null, end_year: null }],
      2026
    );
    expect(future[0].name).toBe("2029/2030");
  });

  it("never duplicates an existing session name", () => {
    const future = buildFutureSessions(
      [
        { name: "2026/2027", start_year: 2026, end_year: 2027 },
        { name: "2029/2030", start_year: 2029, end_year: 2030 },
      ],
      2026
    );
    expect(future.some((f) => f.name === "2029/2030")).toBe(false);
  });

  it("never goes backwards when real sessions are in the past", () => {
    const future = buildFutureSessions(
      [{ name: "2020/2021", start_year: 2020, end_year: 2021 }],
      2026
    );
    expect(future[0].name).toBe("2026/2027");
  });
});

describe("isFutureSessionId", () => {
  it("identifies virtual ids and rejects real uuids", () => {
    expect(isFutureSessionId("future-2028")).toBe(true);
    expect(isFutureSessionId("8b3e938d-a001-4582-a9e1-9263fbec0ff2")).toBe(false);
    expect(isFutureSessionId("")).toBe(false);
    expect(isFutureSessionId(undefined)).toBe(false);
  });
});
