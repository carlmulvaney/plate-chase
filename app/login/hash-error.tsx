'use client'

import { useEffect, useState } from 'react'

/**
 * Supabase repeats an auth failure in the URL fragment as well as the query
 * string, and a fragment never reaches the server. This reads it after mount
 * so the reason is shown rather than left in the address bar.
 */
export function HashError() {
  const [reason, setReason] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const found = params.get('error_description') ?? params.get('error')
    if (!found) return
    // The fragment is only readable in the browser, so this is the earliest
    // point it can be published.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReason(found.replace(/\+/g, ' '))
    history.replaceState(null, '', window.location.pathname)
  }, [])

  if (!reason) return null

  return (
    <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
      {reason}
    </p>
  )
}
