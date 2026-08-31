'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatTarget } from '@/lib/plate'
import { readCaptureTimeForSorting, sortByCaptureTime } from '@/lib/exif-client'
import { PlateRow, type CheckState, type Row } from './plate-row'

type Phase = 'editing' | 'running' | 'finished'

/**
 * One form, any number of claims (B9 in docs/design/bulk-upload.md). A single
 * claim is a batch of one.
 *
 * The batch runs strictly one pair at a time — init, upload, confirm, then the
 * next. Overlapping them is not available: init for pair n+1 needs pair n to
 * exist or rule 2 refuses it, and creating every row upfront means a rule-4
 * failure in the middle deletes a row that later rows were built on, leaving a
 * number nobody can ever claim (B6).
 */
export function SubmitForm({ target }: { target: number }) {
  const [rows, setRows] = useState<Row[]>([])
  const [phase, setPhase] = useState<Phase>('editing')
  const [dragging, setDragging] = useState(false)
  const [heldId, setHeldId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  // The target this batch started from, pinned when it begins.
  //
  // The `target` prop is refreshed from the server the moment the batch ends,
  // so by the time results are on screen it already reflects the claims that
  // just landed. Adding a row's index to it then reports numbers that were
  // never attempted — a batch stopping on 002 announced 004.
  const [batchStart, setBatchStart] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  const locked = phase !== 'editing'
  const claimed = rows.filter((r) => r.status === 'claimed').length
  const stopped = rows.find((r) => r.status === 'failed')

  // Submittable once every row has a plate and none is known to be malformed.
  // 'unknown' counts as permission: if the check could not reach the database
  // we let it through and the constraint decides, rather than blocking on our
  // own inability to ask.
  const canSubmit =
    rows.length > 0 &&
    rows.every((r) => r.plate.trim().length > 0 && (r.check === 'ok' || r.check === 'unknown'))

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    const added: Row[] = await Promise.all(
      Array.from(files).map(async (file) => ({
        id: crypto.randomUUID(),
        file,
        plate: '',
        capturedAt: await readCaptureTimeForSorting(file),
        check: 'idle' as CheckState,
        status: 'waiting' as const,
      })),
    )

    // Oldest first (B3), so a batch shot over an afternoon lines up with the
    // order rule 4 wants. Only the newly added ones are sorted — rows already
    // arranged by hand keep their positions (B4).
    setRows((prev) => [...prev, ...sortByCaptureTime(added)])
  }

  const patch = (id: string, changes: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...changes } : r)))

  function reorder(dropOnId: string) {
    setDragging(false)
    setOverId(null)
    if (!heldId || heldId === dropOnId) return
    setRows((prev) => {
      const from = prev.findIndex((r) => r.id === heldId)
      const to = prev.findIndex((r) => r.id === dropOnId)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    setHeldId(null)
  }

  async function run(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBatchStart(target)
    setPhase('running')

    // Work from a local copy: state updates are queued, and each step needs
    // the outcome of the one before it.
    const batch = [...rows]

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]
      patch(row.id, { status: 'running', message: 'Claiming…' })

      // Whatever number this attempt was aimed at, as the server reports it —
      // from the created claim, or from the refusal. Never derived from the
      // row's position.
      let attempted: number | undefined

      try {
        const initRes = await fetch('/api/submit/init', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plate: row.plate, filename: row.file.name }),
        })
        const init = await initRes.json()
        if (!initRes.ok) {
          attempted = typeof init.target === 'number' ? init.target : undefined
          throw new Error(init.error ?? 'could not start the claim')
        }
        attempted = init.number

        patch(row.id, { message: 'Uploading…' })
        const put = await fetch(init.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': row.file.type || 'application/octet-stream' },
          body: row.file,
        })
        if (!put.ok) throw new Error(`upload failed (HTTP ${put.status})`)

        patch(row.id, { message: 'Reading photo…' })
        const commitRes = await fetch('/api/submit/commit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ claimId: init.claimId }),
        })
        const commit = await commitRes.json()
        if (!commitRes.ok) throw new Error(commit.error ?? 'could not confirm the upload')

        patch(row.id, { status: 'claimed', claimedNumber: commit.number, message: undefined })
      } catch (e) {
        // B5: this pair stopped the batch. Everything before it stands;
        // everything after it is left untouched, so no gap can open (B6).
        patch(row.id, {
          status: 'failed',
          message: e instanceof Error ? e.message : String(e),
          attemptedNumber: attempted,
        })
        for (const later of batch.slice(i + 1)) {
          patch(later.id, { status: 'skipped' })
        }
        break
      }
    }

    setPhase('finished')
    router.refresh()
  }

  function startOver() {
    setRows([])
    setBatchStart(null)
    setPhase('editing')
    router.refresh()
  }

  if (phase === 'finished') {
    const start = batchStart ?? target
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
          <p className="font-medium">
            {claimed} of {rows.length} claimed.
            {claimed > 0 && ' Waiting for a reviewer.'}
          </p>
          {stopped && (
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              The batch stopped at{' '}
              {formatTarget(stopped.attemptedNumber ?? start + rows.indexOf(stopped))}.
              Nothing after it was attempted.
            </p>
          )}
        </div>

        <ul className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <PlateRow
              key={row.id}
              row={row}
              target={start + i}
              locked
              onPlateChange={() => {}}
              onCheck={() => {}}
              onRemove={() => {}}
              onDragStart={() => {}}
              onDragEnd={() => {}}
              onDragOver={() => {}}
              onDrop={() => {}}
            />
          ))}
        </ul>

        <button
          onClick={startOver}
          className="self-start rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition-colors hover:border-neutral-400 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
        >
          Claim more
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={run} className="flex flex-col gap-5">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {rows.length > 1 && !locked && (
        <p className="text-xs text-neutral-500">
          Sorted oldest first. Drag a row to change which plate claims which number.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <PlateRow
              key={row.id}
              row={row}
              target={target + i}
              locked={locked}
              onPlateChange={(id, plate) => patch(id, { plate })}
              onCheck={(id, check) => patch(id, { check })}
              onRemove={(id) => setRows((prev) => prev.filter((r) => r.id !== id))}
              held={heldId === row.id}
              dropBefore={overId === row.id && heldId !== null && heldId !== row.id}
              onDragStart={setHeldId}
              onDragEnd={() => {
                setHeldId(null)
                setOverId(null)
              }}
              onDragOver={(id, e) => {
                e.preventDefault()
                setOverId(id)
              }}
              onDrop={reorder}
            />
          ))}
        </ul>
      )}

      {!locked && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            addFiles(e.dataTransfer.files)
          }}
          className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 transition-colors ${
            dragging
              ? 'border-neutral-900 bg-neutral-100 dark:border-white dark:bg-neutral-800'
              : 'border-neutral-300 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-600'
          }`}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-neutral-500"
            aria-hidden="true"
          >
            <path d="M12 16V4m0 0L7 9m5-5 5 5" />
            <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
          </svg>
          <span className="text-sm font-medium">
            {rows.length === 0 ? 'Tap to choose photos' : 'Add more photos'}
          </span>
          <span className="text-xs text-neutral-500">or drag them here</span>
        </button>
      )}

      <button
        type="submit"
        disabled={locked || !canSubmit}
        className="rounded-md bg-neutral-900 px-3 py-2.5 font-medium text-white transition enabled:hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:enabled:hover:bg-neutral-200"
      >
        {phase === 'running'
          ? 'Submitting…'
          : rows.length > 1
            ? `Submit ${rows.length} claims`
            : 'Submit claim'}
      </button>
    </form>
  )
}
