// Owner authorisation for admin edge functions.
//
// Lifted from the copy that had been repeated in remove-bursar / add-bursar /
// handle-school-request, because promotion and class correction need exactly
// the same check and a fourth copy is how one of them ends up subtly weaker.
//
// verify_jwt alone proves nothing: the anon key is itself a valid JWT. The
// caller's identity has to come from auth.getUser() against their own token.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// The service-role client's type lives behind an esm.sh import neither
// linter can resolve; recordPayment.ts and notify.ts do the same.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export interface OwnerCheck {
  ok: boolean;
  status: number;
  error?: string;
  userId?: string;
}

/** Confirm the caller is signed in AND an owner of this school. */
export const requireSchoolOwner = async (
  admin: Admin,
  req: Request,
  schoolId: string
): Promise<OwnerCheck> => {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) {
    return { ok: false, status: 401, error: "You must be signed in" };
  }

  const callerClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: callerData } = await callerClient.auth.getUser();
  const caller = callerData?.user;
  if (!caller) return { ok: false, status: 401, error: "You must be signed in" };

  const { data: school } = await admin
    .from("schools")
    .select("id, owner_id")
    .eq("id", schoolId)
    .maybeSingle();
  if (!school) return { ok: false, status: 404, error: "School not found" };

  if (school.owner_id === caller.id) {
    return { ok: true, status: 200, userId: caller.id };
  }

  // Ownership can also be held through school_admins, which is how a school
  // registered by one account but handed to another still works.
  const { data: ownerRow } = await admin
    .from("school_admins")
    .select("id")
    .eq("school_id", schoolId)
    .eq("user_id", caller.id)
    .eq("role", "owner")
    .maybeSingle();

  if (ownerRow) return { ok: true, status: 200, userId: caller.id };

  return { ok: false, status: 403, error: "Only school owners can do this" };
};
