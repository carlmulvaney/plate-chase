'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatTarget } from '@/lib/plate'

export type RejectedItem = {
  id: string
  number: number
  plate: string
  submitter: string
  rejectedBy: string | null
  reviewedAt: string | null
  canUndo: boolean
}

export function RejectedList({ items }: { items: RejectedItem[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Rejections</h2>
      {items.length === 0 ? (
        <p className="rounded-lg border border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">No rejections.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <RejectedRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}

function RejectedRow({ item }: { item: RejectedItem }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function undo() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimId: item.id, action: 'undo' }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'could not undo that')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-neutral-300 p-3 dark:border-neutral-700">
      <div className="min-w-0">
        <p className="text-sm">
          {item.submitter} · {formatTarget(item.number)}{' '}
          <span className="font-mono text-neutral-500">{item.plate}</span>
        </p>
        <p className="text-xs text-neutral-500">
          rejected by {item.rejectedBy ?? 'someone'}
          {item.reviewedAt && ` · ${new Date(item.reviewedAt).toLocaleDateString()}`}
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>

      {/*
        Shown only where the policy would permit it — the original rejector, or
        an admin. Hiding it from anyone else is a courtesy: claims_review and
        the update guard refuse regardless of what is on screen. The entry
        stays visible either way, so everyone can see why a streak is stuck.
      */}
      {item.canUndo ? (
        <button
          onClick={undo}
          disabled={busy}
          className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:border-neutral-400 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
        >
          {busy ? 'Undoing…' : 'Undo'}
        </button>
      ) : (
        <span className="shrink-0 text-xs text-neutral-500">not yours to undo</span>
      )}
    </li>
  )
}
