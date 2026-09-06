'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatTarget } from '@/lib/plate'
import { createClient } from '@/lib/supabase/client'

export type BlockedItem = {
  id: string
  number: number
  plate: string
  status: string
  canDelete: boolean
}

/**
 * Claims stranded above the player's first rejection (spec §6).
 *
 * They are in no review queue and in no count, so without this the player is
 * told which number was rejected and never learns these still exist. Whether a
 * claim is blocked comes from v_blocked_claims — this decides nothing.
 */
export function Blocked({ items, blockedBy }: { items: BlockedItem[]; blockedBy: number | null }) {
  if (items.length === 0) return null

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Blocked</h2>
      <p className="text-xs text-neutral-500">
        These sit above your rejection at {blockedBy === null ? 'a rejected claim' : formatTarget(blockedBy)}.
        Nobody will review them and they count for nothing. Claim{' '}
        {blockedBy === null ? 'that number' : formatTarget(blockedBy)} again and they come back.
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <BlockedRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

function BlockedRow({ item }: { item: BlockedItem }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function remove() {
    setBusy(true)
    setError(null)
    // Deleted through RLS rather than a route: claims_delete_own_dead already
    // states who may delete what, and a route would be a second copy of it.
    const supabase = createClient()
    const { error, count } = await supabase
      .from('claims')
      .delete({ count: 'exact' })
      .eq('id', item.id)

    if (error || count === 0) {
      setError(error?.message ?? 'the policy refused that delete')
      setBusy(false)
      return
    }
    router.refresh()
  }

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-neutral-300 p-3 dark:border-neutral-700">
      <div className="min-w-0">
        <p className="text-sm">
          {formatTarget(item.number)}{' '}
          <span className="font-mono text-neutral-500">{item.plate}</span>
        </p>
        <p className="text-xs text-neutral-500">{item.status}</p>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>

      {/* An approved claim carries someone's verdict and is not the
          submitter's to erase; can_delete says so and the policy enforces it. */}
      {item.canDelete ? (
        <button
          onClick={remove}
          disabled={busy}
          className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:border-neutral-400 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
        >
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      ) : (
        <span className="shrink-0 text-xs text-neutral-500">kept</span>
      )}
    </li>
  )
}
