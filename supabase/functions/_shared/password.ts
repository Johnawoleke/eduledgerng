// Shared password rules for student credentials.
//
// Students used to all be created with the literal password "password", so the
// only thing standing between an attacker and an account was knowing the
// student ID — which is a guessable INITIALS-NNNN code. Initial passwords are
// now random per student (see SchoolAdminDashboard), and anything a student
// chooses for themselves has to clear this bar.

const BLOCKLIST = new Set([
  "password", "password1", "passw0rd", "123456", "1234567", "12345678",
  "123456789", "0000", "1111", "1234", "12345", "qwerty", "abc123",
  "letmein", "welcome", "student", "school", "changeme", "eduledger",
]);

export interface PasswordCheck {
  ok: boolean;
  error?: string;
}

// `identifiers` are values the password must not simply repeat back — the
// student's own ID, mainly.
export const checkStudentPassword = (
  candidate: unknown,
  identifiers: (string | null | undefined)[] = []
): PasswordCheck => {
  if (typeof candidate !== "string") {
    return { ok: false, error: "Password must be text" };
  }
  const value = candidate.trim();

  if (value.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters" };
  }
  if (value.length > 50) {
    return { ok: false, error: "Password must be 50 characters or fewer" };
  }
  if (BLOCKLIST.has(value.toLowerCase())) {
    return { ok: false, error: "That password is too common. Please choose another." };
  }
  if (/^(.)\1+$/.test(value)) {
    return { ok: false, error: "Password cannot be the same character repeated" };
  }
  for (const id of identifiers) {
    if (id && value.toLowerCase() === String(id).toLowerCase()) {
      return { ok: false, error: "Password cannot be the same as your Student ID" };
    }
  }
  return { ok: true };
};
