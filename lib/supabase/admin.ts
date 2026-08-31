import 'server-only'

import { createClient } from '@supabase/supabase-js'

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Server-side only — the `server-only` import above turns any accidental
 * client-component import into a build error rather than a leaked key.
 *
 * Use this only where the request genuinely acts as the system rather than as
 * a user: reading an uploaded object back from R2 to stamp EXIF onto a claim,
 * and orphan cleanup. It is never a workaround for an inconvenient policy —
 * if a policy is wrong, fix the policy.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}
