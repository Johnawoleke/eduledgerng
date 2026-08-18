import { describe, it, expect, vi, beforeEach } from "vitest";

// A session with no terms can never hold a fee, because a fee is keyed to a
// term. That pairing used to be written out twice and the second copy shipped
// without the terms — a school could have promoted its whole roster into a year
// it could never bill for. These tests pin the invariant, not the plumbing:
// this function never hands back a session that has no terms.

type Row = Record<string, unknown>;
const inserts: { table: string; rows: Row & Row[] }[] = [];
let sessionInsertFails = false;
let termsInsertFails = false;

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      insert: (rows: Row & Row[]) => {
        inserts.push({ table, rows });
        if (table === "terms") {
          return Promise.resolve({ error: termsInsertFails ? { message: "terms boom" } : null });
        }
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                sessionInsertFails
                  ? { data: null, error: { message: "session boom" } }
                  : { data: { id: "sess-1", name: rows.name }, error: null }
              ),
          }),
        };
      },
    }),
  },
}));

const { createSessionWithTerms, DEFAULT_TERMS } = await import("./academicSessions");

beforeEach(() => {
  inserts.length = 0;
  sessionInsertFails = false;
  termsInsertFails = false;
});

describe("createSessionWithTerms", () => {
  it("always creates the three terms alongside the session", async () => {
    const r = await createSessionWithTerms("school-1", "2027/2028");
    expect(r.error).toBeNull();
    expect(r.session).toMatchObject({ id: "sess-1", name: "2027/2028" });

    expect(inserts.map((i) => i.table)).toEqual(["sessions", "terms"]);
    const terms = inserts[1].rows;
    expect(terms).toHaveLength(3);
    expect(terms.map((t) => t.name)).toEqual([...DEFAULT_TERMS]);
    expect(terms.map((t) => t.term_number)).toEqual([1, 2, 3]);
    // Only the first term is current, or the selector has no single default.
    expect(terms.filter((t) => t.is_current)).toHaveLength(1);
    expect(terms.every((t) => t.session_id === "sess-1")).toBe(true);
  });

  it("derives the years from the session name", async () => {
    await createSessionWithTerms("school-1", "2030/2031");
    expect(inserts[0].rows).toMatchObject({ start_year: 2030, end_year: 2031 });
  });

  it("survives a name that is not YYYY/YYYY rather than writing NaN", async () => {
    await createSessionWithTerms("school-1", "Session A");
    expect(inserts[0].rows).toMatchObject({ start_year: null, end_year: null });
  });

  it("returns NO session when the terms fail — never a half-built one", async () => {
    termsInsertFails = true;
    const r = await createSessionWithTerms("school-1", "2027/2028");
    // The caller must not get an id it would then promote students into.
    expect(r.session).toBeNull();
    expect(r.error).toContain("terms could not be added");
  });

  it("reports a session failure without attempting terms", async () => {
    sessionInsertFails = true;
    const r = await createSessionWithTerms("school-1", "2027/2028");
    expect(r.session).toBeNull();
    expect(r.error).toBe("session boom");
    expect(inserts.map((i) => i.table)).toEqual(["sessions"]);
  });

  it("is not current unless asked", async () => {
    await createSessionWithTerms("school-1", "2027/2028");
    expect(inserts[0].rows.is_current).toBe(false);
    inserts.length = 0;
    await createSessionWithTerms("school-1", "2027/2028", { isCurrent: true });
    expect(inserts[0].rows.is_current).toBe(true);
  });
});
