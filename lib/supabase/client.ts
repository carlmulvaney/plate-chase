import { createBrowserClient } from '@supabase/ssr'

/**
 * Browser-side Supabase client. The anon key is the only key that may reach
 * the browser; every read and write it makes is subject to RLS.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
