import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client that uses the service-role key.
// Bypasses RLS — use only for trusted server-side checks (e.g. admin lookup
// against Stacklabs' User table). Never expose to the browser.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
