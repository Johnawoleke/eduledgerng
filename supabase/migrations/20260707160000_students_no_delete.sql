-- =============================================================================
-- Students are ARCHIVED, never removed. Drop the students DELETE policy so no
-- client (owner, bursar, or anyone with the anon key) can hard-delete a student
-- row via the API — removal is only possible through archiving (status change).
--
-- Note: a school being deleted still cascades to its students via the FK; this
-- only blocks deleting an individual student directly. Idempotent.
-- =============================================================================

drop policy if exists eduledger_students_delete on public.students;
