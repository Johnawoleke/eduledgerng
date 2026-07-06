# Archived migrations

These migrations describe the schema of the ORIGINAL Lovable-managed Supabase
project (`eymbfxjnmvrhdxaorwcq`), which was abandoned on 2026-04-22 when the
project moved to the owner's personal Supabase project (`ifonivphhfplntzshtsb`).

The live database was rebuilt by hand at that point and diverged significantly
(e.g. it uses `sessions`/`terms` instead of `academic_sessions`/`academic_terms`,
different `students`/`profiles`/`payments` columns). These files are kept for
history only — they must NEVER be applied to the live or staging databases.

The canonical migration chain starts at
`../migrations/20260706120000_baseline_live_schema.sql`, which recreates the
live production schema as verified on 2026-07-06.
