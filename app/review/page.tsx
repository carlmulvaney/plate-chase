import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import { displayPhotoUrlIfPresent } from '@/lib/photo-urls'
import { ReviewCard, type QueueItem } from './review-card'
import { RejectedList, type RejectedItem } from './rejected-list'

export const dynamic = 'force-dynamic'

export default async function ReviewPage() {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) redirect('/login')

  // Who may review what is decided by v_review_queue, which reads the same
  // facts the policies do. Nothing is filtered here.
  const { data: queue } = await supabase
    .from('v_review_queue')
    .select(
      'id, submitter, number, plate, photo_key, captured_at, previous_captured_at, previous_number, claims_after, can_reject',
    )

  const { data: rejected } = await supabase
    .from('v_rejected_claims')
    .select('id, number, plate, submitter, rejected_by, reviewed_at, can_undo')
    .limit(10)

  const next = queue?.[0]
  const item: QueueItem | null = next
    ? {
        id: next.id,
        submitter: next.submitter,
        number: next.number,
        plate: next.plate,
        // Minted per render and short-lived; neither bucket is public.
        photoUrl: await displayPhotoUrlIfPresent(next.photo_key),
        capturedAt: next.captured_at,
        previousCapturedAt: next.previous_captured_at,
        previousNumber: next.previous_number,
        claimsAfter: next.claims_after,
        canReject: next.can_reject,
      }
    : null

  const rejectedItems: RejectedItem[] = (rejected ?? []).map((r) => ({
    id: r.id,
    number: r.number,
    plate: r.plate,
    submitter: r.submitter,
    rejectedBy: r.rejected_by,
    reviewedAt: r.reviewed_at,
    canUndo: r.can_undo,
  }))

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 p-6">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">Review</h1>
        <Link href="/submit" className="text-sm text-neutral-500 underline underline-offset-4">
          Submit
        </Link>
      </header>

      {item ? (
        <ReviewCard item={item} remaining={(queue?.length ?? 1) - 1} />
      ) : (
        <p className="rounded-lg border border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">No claims to review.</p>
      )}

      <RejectedList items={rejectedItems} />
    </main>
  )
}
