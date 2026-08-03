import { describe, it, expect } from "vitest";
// The edge functions' shared password policy. It has no Deno-specific imports,
// so it can be exercised directly here rather than only in deployed functions.
import { checkStudentPassword } from "../../supabase/functions/_shared/password";

describe("checkStudentPassword", () => {
  it("accepts a reasonable password", () => {
    expect(checkStudentPassword("Kv7pra2M")).toEqual({ ok: true });
  });

  it("rejects the password every student used to be created with", () => {
    expect(checkStudentPassword("password").ok).toBe(false);
    expect(checkStudentPassword("PASSWORD").ok).toBe(false);
    expect(checkStudentPassword("Password").ok).toBe(false);
  });

  it("rejects other common choices", () => {
    for (const weak of ["123456", "qwerty", "letmein", "changeme", "student"]) {
      expect(checkStudentPassword(weak).ok, weak).toBe(false);
    }
  });

  it("enforces a minimum length", () => {
    expect(checkStudentPassword("abc").ok).toBe(false);
    expect(checkStudentPassword("12345").ok).toBe(false);
    expect(checkStudentPassword("abcdef").ok).toBe(true);
  });

  it("enforces a maximum length matching what login accepts", () => {
    expect(checkStudentPassword("a".repeat(50) + "b").ok).toBe(false);
  });

  it("rejects a single repeated character", () => {
    expect(checkStudentPassword("aaaaaa").ok).toBe(false);
    expect(checkStudentPassword("999999").ok).toBe(false);
  });

  it("rejects reusing the student's own ID", () => {
    expect(checkStudentPassword("OCD-1234", ["OCD-1234"]).ok).toBe(false);
    expect(checkStudentPassword("ocd-1234", ["OCD-1234"]).ok).toBe(false);
    expect(checkStudentPassword("ocd-9999", ["OCD-1234"]).ok).toBe(true);
  });

  it("rejects non-string input", () => {
    expect(checkStudentPassword(undefined).ok).toBe(false);
    expect(checkStudentPassword(1234).ok).toBe(false);
    expect(checkStudentPassword(null).ok).toBe(false);
  });

  it("always explains why it refused", () => {
    const result = checkStudentPassword("abc");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
