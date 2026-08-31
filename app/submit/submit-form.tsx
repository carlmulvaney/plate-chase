'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatTarget } from '@/lib/plate'

type Phase = 'idle' | 'claiming' | 'uploading' | 'confirming' | 'done' | 'error'

type Result = {
  number: number
  capturedAt: string | null
  needsHumanOrdering: boolean
  displayReady: boolean
}

export function SubmitForm({ target }: { target: number }) {
  const [plate, setPlate] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [failedFor, setFailedFor] = useState<File | null>(null)
  const [plateCheck, setPlateCheck] = useState<
    'idle' | 'checking' | 'ok' | 'bad' | 'unknown'
  >('idle')
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  const busy = phase === 'claiming' || phase === 'uploading' || phase === 'confirming'

  // Enabled once there is a photo and the plate is not known to be bad.
  // 'unknown' counts as permission: if the check could not reach the database
  // we let the submission through and the constraint decides, rather than
  // blocking on our own inability to ask.
  const canSubmit = file !== null && (plateCheck === 'ok' || plateCheck === 'unknown')

  // A preview URL points at the file the browser already holds; it does not
  // read, decode or re-encode it. The bytes that get uploaded stay the bytes
  // the camera produced, EXIF and all.
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])

  // Some formats the camera produces cannot be rendered by a browser at all —
  // HEIC above all, which is the iPhone default. Rather than guess from the
  // extension, let the <img> try and note which File it gave up on. Comparing
  // against the current file means choosing another one clears this by itself.
  const previewFailed = file !== null && failedFor === file

  // Ask the database whether this looks like a plate, rather than keeping a
  // second copy of the pattern here. /api/plate/check calls the same
  // is_valid_plate() the check constraint uses, so the hint cannot disagree
  // with the verdict. Debounced, and every state change happens inside the
  // timer so a keystroke never renders a stale answer.
  useEffect(() => {
    const value = plate.trim()
    const controller = new AbortController()

    const timer = setTimeout(async () => {
      if (value.length === 0) {
        setPlateCheck('idle')
        return
      }
      setPlateCheck('checking')
      try {
        const res = await fetch(`/api/plate/check?plate=${encodeURIComponent(value)}`, {
          signal: controller.signal,
        })
        if (!res.ok) {
          // Including 502. The database could not be asked, so we have no
          // opinion — and 'unknown' must not gate the button, or an outage
          // would lock someone out of submitting a perfectly good plate.
          setPlateCheck('unknown')
          return
        }
        const body = await res.json()
        setPlateCheck(body.valid ? 'ok' : 'bad')
      } catch {
        // An abort is the next keystroke overtaking this one — not a failure,
        // and the newer request will answer. Anything else is offline.
        if (!controller.signal.aborted) setPlateCheck('unknown')
      }
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [plate])

  // Release the handle when the file changes or the form goes away.
  useEffect(() => {
    if (!preview) return
    return () => URL.revokeObjectURL(preview)
  }, [preview])

  function choose(next: File | null) {
    setFile(next)
    setMessage(null)
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault()
    setDragging(false)
    const dropped = event.dataTransfer.files?.[0]
    if (dropped) choose(dropped)
  }

  function reset() {
    setPhase('idle')
    setPlate('')
    setFile(null)
    setResult(null)
    setMessage(null)
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) return
    setMessage(null)
    setResult(null)

    try {
      // 1. Claim the slot. The database decides whether this plate and target
      //    are allowed; we just report what it said.
      setPhase('claiming')
      const initRes = await fetch('/api/submit/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plate, filename: file.name }),
      })
      const init = await initRes.json()
      if (!initRes.ok) throw new Error(init.error ?? 'could not start the claim')

      // 2. Upload the ORIGINAL file, untouched. No resizing, no canvas — that
      //    would strip the EXIF capture time rule 4 depends on.
      setPhase('uploading')
      const put = await fetch(init.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!put.ok) throw new Error(`upload failed (HTTP ${put.status})`)

      // 3. Confirm, which is where EXIF is read and rule 4 is judged.
      setPhase('confirming')
      const commitRes = await fetch('/api/submit/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claimId: init.claimId }),
      })
      const commit = await commitRes.json()
      if (!commitRes.ok) throw new Error(commit.error ?? 'could not confirm the upload')

      setResult(commit)
      setPhase('done')

      // The target and the confirmed count live in the server component that
      // renders this form. Without re-running it, "Claim the next one" would
      // hand back a form still pointing at the number just claimed. Done here
      // rather than in reset() so the new target has arrived by the time the
      // form is shown again.
      router.refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }

  if (phase === 'done' && result) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
        <p className="font-medium">
          Claimed {formatTarget(result.number)}. Waiting for a reviewer.
        </p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {result.capturedAt
            ? `Photo taken ${new Date(result.capturedAt).toLocaleString()}.`
            : 'This photo carries no capture time, so a reviewer will judge the ordering by hand. That is not a problem with your claim.'}
        </p>
        <button
          onClick={reset}
          className="self-start rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
        >
          Claim the next one
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="plate" className="text-sm font-medium">
          Plate
        </label>
        <input
          id="plate"
          required
          value={plate}
          onChange={(e) => setPlate(e.target.value.toUpperCase())}
          placeholder={`1ABC${formatTarget(target)}`}
          maxLength={7}
          className="rounded-md border border-neutral-300 px-3 py-2 font-mono text-lg tracking-widest dark:border-neutral-700 dark:bg-neutral-900"
        />
        {/*
          Always rendered, so the line it occupies is reserved whether or not
          there is anything to say. Mounting it conditionally shifted the photo
          field and the submit button down as soon as the check came back.
        */}
        <p
          aria-live="polite"
          className={`min-h-4 text-xs ${
            plateCheck === 'bad'
              ? 'text-amber-600 dark:text-amber-500'
              : 'text-green-600 dark:text-green-500'
          }`}
        >
          {plateCheck === 'bad' && 'Invalid plate format (e.g. 1ABC234)'}
          {plateCheck === 'ok' && 'Valid plate format'}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Photo</span>

        <input
          ref={inputRef}
          id="photo"
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />

        {!file ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-10 transition-colors ${
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
            <span className="text-sm font-medium">Tap to choose a photo</span>
            <span className="text-xs text-neutral-500">or drag one here</span>
          </button>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-neutral-300 p-3 dark:border-neutral-700">
            {previewFailed ? (
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-[10px] font-semibold tracking-wide text-neutral-500 dark:bg-neutral-800"
                aria-hidden="true"
              >
                {extensionLabel(file.name)}
              </div>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={preview ?? ''}
                alt=""
                onError={() => setFailedFor(file)}
                className="h-14 w-14 shrink-0 rounded-md object-cover"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{file.name}</p>
              <p className="text-xs text-neutral-500">{formatBytes(file.size)}</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="shrink-0 rounded-md border border-neutral-300 px-2.5 py-1 text-xs transition-colors enabled:hover:border-neutral-400 enabled:hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:enabled:hover:border-neutral-600 dark:enabled:hover:bg-neutral-800"
            >
              Change
            </button>
          </div>
        )}

      </div>

      <button
        type="submit"
        disabled={busy || !canSubmit}
        className="rounded-md bg-neutral-900 px-3 py-2.5 font-medium text-white transition enabled:hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:enabled:hover:bg-neutral-200"
      >
        {phase === 'claiming' && 'Claiming…'}
        {phase === 'uploading' && 'Uploading photo…'}
        {phase === 'confirming' && 'Reading photo…'}
        {(phase === 'idle' || phase === 'error') && 'Submit claim'}
      </button>

      {message && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {message}
        </p>
      )}
    </form>
  )
}

function extensionLabel(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return 'FILE'
  return filename.slice(dot + 1).toUpperCase().slice(0, 4)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
