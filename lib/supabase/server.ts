import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Server-side Supabase client acting as the signed-in user. Still the anon key,
 * so RLS applies — this is the client almost everything should use.
 *
 * `cookies()` is async in Next 16; synchronous access was removed.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Called from a Server Component, which cannot set cookies.
            // Harmless when a proxy is refreshing the session.
          }
        },
      },
    },
  )
}
