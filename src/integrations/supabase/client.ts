import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// Production values are hardcoded ON PURPOSE (see notes/supabase-env-vars.md) so
// Vercel deploys need no env config. The env vars exist only so local dev can
// target the staging project via .env.local — they are never set in production.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://ifonivphhfplntzshtsb.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_dz8sfx1QwMpIHe6is9NIUQ_067PGY1g";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});