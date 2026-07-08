-- =============================================================================
-- Store the invited email directly on each invitation, so the owner's staff
-- panel always shows WHO was invited — even for declined/expired invites whose
-- user has no readable profiles row. Previously the email was looked up from
-- profiles and fell back to "—" when no profile existed.
-- =============================================================================

alter table public.school_requests add column if not exists email text;
