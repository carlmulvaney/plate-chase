import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * The bare domain, and where Supabase lands both halves of an authentication
 * outcome: a magic link goes to the project's Site URL unless a redirect is
 * both requested and allow-listed in the dashboard, so this is the address the
 * emailed link actually opens.
 *
 * A code is handed to /auth/callback, which owns the exchange. An error — an
 * expired link, a used one — is carried to the login screen so it can be read
 * there, rather than sitting unexplained in the URL of a page that says
 * nothing. Otherwise: signed in goes to the submit screen, signed out to sign
 * in.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; error?: string; error_description?: string }>
}) {
  const params = await searchParams
  const reason = params.error_description ?? params.error

  if (reason) {
    redirect(`/login?error=${encodeURIComponent(reason)}`)
  }

  if (params.code) {
    redirect(`/auth/callback?code=${encodeURIComponent(params.code)}`)
  }

  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  redirect(data.user ? '/submit' : '/login')
}
