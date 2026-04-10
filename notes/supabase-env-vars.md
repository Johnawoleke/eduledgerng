# Supabase Client — Hardcoded Public Keys

## What we did (2026-04-10)

Hardcoded the Supabase anon key and URL directly in `src/integrations/supabase/client.ts`
instead of reading from `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` env vars.

## Why

- The project owner deploys on Vercel and is not familiar with environment variable configuration.
- These two values are the **Supabase anon (publishable) key** and the **project URL** — both are
  public by design. They ship in the frontend JavaScript bundle to every user's browser regardless
  of how they're loaded. Supabase explicitly names this key "publishable" for this reason.
- Hardcoding them eliminates the need for any Vercel env var setup and makes deploys just work.

## What is NOT hardcoded (and must never be)

These secrets live as **Supabase Edge Function secrets** (set via `supabase secrets set`), never
in the repo:

- `SUPABASE_SERVICE_ROLE_KEY` — full database access, bypasses RLS
- `ZENDFI_TEST_KEY` — Zendfi API key for creating payment links
- `ZENDFI_WEBHOOK_SECRET` — HMAC signing secret for verifying inbound webhooks

## If you want to revert to env vars later

1. Restore `client.ts` to read from `import.meta.env`:
   ```ts
   const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
   const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
   ```
2. Add the two env vars in Vercel: Project > Settings > Environment Variables
   - `VITE_SUPABASE_URL` = `https://eymbfxjnmvrhdxaorwcq.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = the anon key (from Supabase dashboard > Settings > API)
3. Redeploy.
