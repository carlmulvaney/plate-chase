'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/**
 * Sign-in by six-digit code rather than a link.
 *
 * A magic link has to be opened in the same browser that requested it — PKCE
 * stores the code verifier there. On a phone that is a coin flip: the link is
 * requested in Safari and opened by the mail app's in-app browser, which has
 * different storage, and sign-in fails with an error about a missing verifier.
 * Since this app is used from a phone, that failure would be the common case.
 *
 * A code is typed into the page that is already open, so nothing has to be
 * opened anywhere and there is no cross-browser dependency at all.
 *
 * Supabase's built-in email service cannot render the code: its templates are
 * locked until a custom SMTP provider is configured, so today the email only
 * carries a link. Both paths are therefore offered — /auth/callback still
 * handles the link — and the code becomes the primary route once SMTP is set
 * up and the template can emit {{ .Token }}.
 */
export function LoginForm() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function sendCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({ email })

    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setStep('code')
  }

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)

    const supabase = createClient()
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    })

    if (error) {
      setBusy(false)
      setError(error.message)
      return
    }

    // refresh() first so server components re-run against the session cookies
    // the verification just wrote; push() alone would render /submit from a
    // cache that still believes nobody is signed in.
    router.refresh()
    router.push('/submit')
  }

  if (step === 'code') {
    return (
      <form onSubmit={verify} className="flex flex-col gap-3">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Check {email}. Enter the six-digit code, or open the link in the
          email <em>in this browser</em>.
        </p>
        <label htmlFor="code" className="text-sm font-medium">
          Code
        </label>
        <input
          id="code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          className="rounded-md border border-neutral-300 px-3 py-2 text-center font-mono text-2xl tracking-[0.4em] dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={busy || code.length < 6}
          className="rounded-md bg-neutral-900 px-3 py-2.5 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <button
          type="button"
          onClick={() => {
            setStep('email')
            setCode('')
            setError(null)
          }}
          className="text-sm text-neutral-500 underline underline-offset-4"
        >
          Use a different email
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    )
  }

  return (
    <form onSubmit={sendCode} className="flex flex-col gap-3">
      <label htmlFor="email" className="text-sm font-medium">
        Email
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
        placeholder="you@example.com"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-neutral-900 px-3 py-2.5 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {busy ? 'Sending…' : 'Email me a code'}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  )
}
