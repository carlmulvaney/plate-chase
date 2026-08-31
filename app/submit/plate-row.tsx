'use client'

import { useEffect, useState } from 'react'
import { formatTarget } from '@/lib/plate'

export type CheckState = 'idle' | 'checking' | 'ok' | 'bad' | 'unknown'
export type RowStatus = 'waiting' | 'running' | 'claimed' | 'failed' | 'skipped'

export type Row = {
  id: string
  file: File
  plate: string
  capturedAt: number | null
  check: CheckState
  status: RowStatus
  message?: string
  claimedNumber?: number
  /** The number this row aimed at, as reported by the server. */
  attemptedNumber?: number
}

export function PlateRow({
  row,
  target,
  locked,
  held,
  dropBefore,
  onPlateChange,
  onCheck,
  onRemove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  row: Row
  target: number
  locked: boolean
  held?: boolean
  dropBefore?: boolean
  onPlateChange: (id: string, plate: string) => void
  onCheck: (id: string, check: CheckState) => void
  onRemove: (id: string) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDragOver: (id: string, event: React.DragEvent) => void
  onDrop: (id: string) => void
}) {
  const preview = usePreview(row.file)

  // Same debounced question as before, asked per row: is this shaped like a
  // plate? Answered by is_valid_plate() in the database, so the hint cannot
  // disagree with the constraint that ultimately refuses.
  useEffect(() => {
    const value = row.plate.trim()
    const controller = new AbortController()

    const timer = setTimeout(async () => {
      if (value.length === 0) {
        onCheck(row.id, 'idle')
        return
      }
      onCheck(row.id, 'checking')
      try {
        const res = await fetch(`/api/plate/check?plate=${encodeURIComponent(value)}`, {
          signal: controller.signal,
        })
        if (!res.ok) {
          onCheck(row.id, 'unknown')
          return
        }
        const body = await res.json()
        onCheck(row.id, body.valid ? 'ok' : 'bad')
      } catch {
        if (!controller.signal.aborted) onCheck(row.id, 'unknown')
      }
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // onCheck is stable; re-running on it would restart the debounce endlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.plate, row.id])

  const tone =
    row.status === 'claimed'
      ? 'border-green-600/40 bg-green-600/5 dark:border-green-500/40'
      : row.status === 'failed'
        ? 'border-red-500/50 bg-red-500/5'
        : row.status === 'skipped'
          ? 'border-neutral-300 opacity-50 dark:border-neutral-700'
          : 'border-neutral-300 dark:border-neutral-700'

  return (
    <li
      draggable={!locked}
      onDragStart={() => onDragStart(row.id)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOver(row.id, e)}
      onDrop={() => onDrop(row.id)}
      className="relative"
    >
      {/* Where the dragged row will land, drawn in the gap above this one. */}
      {dropBefore && (
        <span
          aria-hidden="true"
          className="absolute -top-1 left-0 right-0 h-0.5 rounded-full bg-neutral-900 dark:bg-white"
        />
      )}

      <div
        className={`flex items-start gap-3 rounded-lg border p-3 transition-all ${tone} ${
          locked ? '' : 'cursor-grab active:cursor-grabbing'
        } ${held ? 'opacity-40' : ''}`}
      >
        <div className="shrink-0">
          {preview.failed ? (
            <div
              className="flex h-12 w-12 items-center justify-center rounded-md bg-neutral-100 text-[10px] font-semibold text-neutral-500 dark:bg-neutral-800"
              aria-hidden="true"
            >
              {extensionLabel(row.file.name)}
            </div>
          ) : preview.url ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={preview.url}
              alt=""
              onError={preview.markFailed}
              className="h-12 w-12 rounded-md object-cover"
            />
          ) : (
            // The URL is created in an effect, so the very first render has
            // nothing yet. A blank tile rather than the extension label, which
            // would flash a false "cannot preview this" for an instant.
            <div className="h-12 w-12 rounded-md bg-neutral-100 dark:bg-neutral-800" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <input
            value={row.plate}
            disabled={locked}
            onChange={(e) => onPlateChange(row.id, e.target.value.toUpperCase())}
            placeholder={`1ABC${formatTarget(target)}`}
            maxLength={7}
            aria-label={`Plate for target ${formatTarget(target)}`}
            className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 font-mono tracking-widest disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <p className="mt-1 truncate text-xs text-neutral-500">{row.file.name}</p>
          <p aria-live="polite" className={`min-h-4 text-xs ${messageTone(row, locked)}`}>
            {row.status === 'failed' && row.message}
            {row.status === 'claimed' && `Claimed ${formatTarget(row.claimedNumber ?? target)}`}
            {row.status === 'skipped' && 'Not attempted'}
            {row.status === 'waiting' && locked && 'Queued'}
            {row.status === 'running' && (row.message ?? 'Working…')}
            {row.status === 'waiting' &&
              !locked &&
              row.check === 'bad' &&
              'Invalid plate format (e.g. 1ABC234)'}
            {row.status === 'waiting' && !locked && row.check === 'ok' && 'Valid plate format'}
          </p>
        </div>

        {!locked && (
          <button
            type="button"
            onClick={() => onRemove(row.id)}
            aria-label={`Remove ${row.file.name}`}
            className="shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs transition-colors hover:border-neutral-400 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        )}
      </div>
    </li>
  )
}

/**
 * The colour of a row's status line.
 *
 * Everything that is not a verdict is neutral: a row that was never attempted
 * has no outcome to report, and reading as green made a stopped batch look
 * like it had succeeded.
 */
function messageTone(row: Row, locked: boolean): string {
  if (row.status === 'failed') return 'text-red-600 dark:text-red-400'
  if (row.status === 'claimed') return 'text-green-600 dark:text-green-500'
  if (row.status === 'skipped' || row.status === 'running') return 'text-neutral-500'
  // Queued: waiting its turn in a running batch. Not a verdict, so not green.
  if (row.status === 'waiting' && locked) return 'text-neutral-500'
  if (row.check === 'bad') return 'text-amber-600 dark:text-amber-500'
  return 'text-green-600 dark:text-green-500'
}

/**
 * An object URL for the file, plus a way to record that the browser could not
 * render it.
 *
 * The URL is created *inside* the effect and revoked by that same effect's
 * cleanup. That matters: React's development Strict Mode mounts effects, tears
 * them down, and mounts them again. Creating the URL outside the effect — with
 * useMemo, say — means the teardown revokes the only URL there will ever be,
 * every <img> then fails to load, and every photo falls back to the "cannot
 * preview" tile regardless of its format. Created here, the remount simply
 * makes a fresh one.
 */
function usePreview(file: File): { url: string | null; failed: boolean; markFailed: () => void } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({
    url: null,
    failed: false,
  })

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    // The URL has to be created and revoked by the same effect for Strict
    // Mode's mount/unmount/mount to leave a live one behind, which means the
    // effect is the only place that can publish it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ url: objectUrl, failed: false })
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  return {
    url: state.url,
    failed: state.failed,
    markFailed: () => setState((prev) => ({ ...prev, failed: true })),
  }
}

function extensionLabel(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return 'FILE'
  return filename.slice(dot + 1).toUpperCase().slice(0, 4)
}
