-- =============================================================================
-- SCOPE class_fees READS TO SCHOOL MEMBERS
--
-- The SELECT policy was `status = 'published' or is_school_member(school_id)`,
-- so every school's published fee schedule — every fee name and every amount —
-- was readable by anyone holding the public anon key. A signed-in stranger with
-- no school membership could enumerate the pricing of every school on the
-- platform.
--
-- The `published` branch dates from an older design where the student dashboard
-- read class_fees directly. It no longer does: student fee summaries are
-- computed server-side by the `student-auth` edge function, which uses the
-- service role and bypasses RLS entirely. The only browser-side reader left is
-- SchoolAdminDashboard, which always runs as an authenticated school member.
--
-- Edge functions are unaffected (service role bypasses RLS). If a future
-- student-facing page ever needs to read class_fees with the anon key, route it
-- through an edge function instead of widening this policy back out.
--
-- Idempotent. Run on prod via SQL editor; on staging via db push.
-- =============================================================================

drop policy if exists eduledger_class_fees_select on public.class_fees;
create policy eduledger_class_fees_select on public.class_fees
  for select using (public.is_school_member(school_id));
