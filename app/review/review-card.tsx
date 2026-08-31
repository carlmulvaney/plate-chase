'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatTarget } from '@/lib/plate'

export type QueueItem = {
  id: string
  submitter: string
  number: number
  plate: string
  photoUrl: string
  capturedAt: string | null
  previousCapturedAt: string | null
  /** Null when there is no predecessor at all — the start of a run. */
  previousNumber: number | null
  /** Claims of theirs above this one, which a rejection would orphan. */
  claimsAfter: number
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

export function ReviewCard({ item, remaining }: { item: QueueItem; remaining: number }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What was just rejected, held independently of `item`. The claim leaves the
  // queue the moment it is rejected, so `item` has already moved on to the next
  // one by the time this renders — the confirmation cannot read from it.
  const [rejected, setRejected] = useState<{
    claimId: string
    number: number
    submitter: string
    claimsAfter: number
  } | null>(null)
  const router = useRouter()

  async function undoRejection(claimId: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimId, action: 'undo' }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'could not undo that')
      setRejected(null)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function decide(action: 'approve' | 'reject') {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimId: item.id, action }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'could not record that')

      if (action === 'reject') {
        setRejected({
          claimId: item.id,
          number: item.number,
          submitter: item.submitter,
          claimsAfter: item.claimsAfter,
        })
      }
      // Approving needs no confirmation — there is nothing to take back, so
      // the next claim simply appears.
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (rejected) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
        <div className="flex items-center justify-between gap-3">
          <p className="font-medium">Rejected {formatTarget(rejected.number)}.</p>
          <button
            onClick={() => undoRejection(rejected.claimId)}
            disabled={busy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:border-neutral-400 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
          >
            {busy ? 'Undoing…' : 'Undo'}
          </button>
        </div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {rejected.claimsAfter > 0
            ? `${rejected.claimsAfter} claim${rejected.claimsAfter === 1 ? '' : 's'} after this ${
                rejected.claimsAfter === 1 ? 'is' : 'are'
              } blocked until ${formatTarget(rejected.number)} is resolved.`
            : `${rejected.submitter} is back to ${formatTarget(rejected.number)}.`}
        </p>
        <button
          onClick={() => setRejected(null)}
          className="self-start text-sm text-neutral-500 underline underline-offset-4"
        >
          Next claim
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    )
  }

  const ordering = orderingNote(item)

  return (
    <div className="flex w-full flex-col gap-4 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">
          {item.submitter} · {formatTarget(item.number)}
        </h2>
        <span className="font-mono text-lg tracking-widest">{item.plate}</span>
      </div>

      {/*
        Fixed height, image contained within it. Photos arrive portrait and
        landscape and at any resolution; sizing the box to the image moved the
        verdict buttons every time one loaded, which is the last pair of
        buttons on this project that should shift under the cursor.
      */}
      <div className="flex h-80 w-full items-center justify-center overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.photoUrl}
          alt={`Claimed plate ${item.plate}`}
          className="max-h-full max-w-full object-contain"
        />
      </div>

      {/*
        Rule 4 is enforced on a value nobody sees. A reviewer who cannot compare
        these two times cannot catch a photo that is well formed but out of
        order, so this sits directly above the buttons rather than in a corner.
      */}
      <dl className="rounded-md bg-neutral-100 p-3 text-sm dark:bg-neutral-900">
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">Taken</dt>
          <dd>{item.capturedAt ? when(item.capturedAt) : 'no capture time'}</dd>
        </div>
        {/*
          Always rendered, even with no predecessor. Omitting the row made this
          block a line shorter on the first claim of a run, so everything below
          it — including the verdict buttons — moved when you advanced.
        */}
        <div className="mt-1 flex justify-between gap-3">
          <dt className="text-neutral-500">
            {item.previousNumber !== null
              ? `Previous (${formatTarget(item.previousNumber)})`
              : 'Previous'}
          </dt>
          <dd>
            {item.previousNumber === null
              ? 'none'
              : item.previousCapturedAt
                ? when(item.previousCapturedAt)
                : 'no capture time'}
          </dd>
        </div>
        {/* Two lines' worth of space, so the longest note does not shift it. */}
        <p className={`mt-2 min-h-8 text-xs ${ordering.tone}`}>{ordering.text}</p>
      </dl>

      <div className="flex gap-3">
        <button
          onClick={() => decide('reject')}
          disabled={busy}
          className="flex-1 rounded-md bg-red-600 px-3 py-2.5 font-medium text-white transition enabled:hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reject
        </button>
        <button
          onClick={() => decide('approve')}
          disabled={busy}
          className="flex-1 rounded-md bg-green-600 px-3 py-2.5 font-medium text-white transition enabled:hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Approve
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-xs text-neutral-500">
        {remaining > 0 ? `${remaining} more waiting` : 'Last one'}
      </p>
    </div>
  )
}

/** What the two capture times say about rule 4, in words. */
function orderingNote(item: QueueItem): { text: string; tone: string } {
  // No predecessor: the start of a run, or at or below the player's seed_next.
  // Rule 4 passed vacuously and there is no ordering to second-guess.
  if (item.previousNumber === null) {
    return {
      text: 'No earlier plate to compare against.',
      tone: 'text-neutral-500',
    }
  }
  if (!item.capturedAt || !item.previousCapturedAt) {
    return {
      text: 'No capture time on one of these, so the order was not checked. Your call.',
      tone: 'text-amber-600 dark:text-amber-500',
    }
  }
  const gap = new Date(item.capturedAt).valueOf() - new Date(item.previousCapturedAt).valueOf()
  const hours = Math.round(gap / 3_600_000)
  if (gap <= 0) {
    return {
      text: 'Taken before the previous plate — the database should not have accepted this.',
      tone: 'text-red-600 dark:text-red-400',
    }
  }
  const span = hours < 1 ? 'less than an hour' : hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`
  return { text: `Taken ${span} after the previous plate.`, tone: 'text-neutral-500' }
}
