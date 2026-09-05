import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * The bare domain, and where Supabase sends authentication errors.
 *
 * Signed in goes to the submit screen; signed out goes to sign in. An error
 * from Supabase — an expired link, a used one — is carried to the login screen
 * so it can be read there, rather than sitting unexplained in the URL of a
 * page that says nothing.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; error_description?: string }>
}) {
  const params = await searchParams
  const reason = params.error_description ?? params.error

  if (reason) {
    redirect(`/login?error=${encodeURIComponent(reason)}`)
  }

  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  redirect(data.user ? '/submit' : '/login')
}
