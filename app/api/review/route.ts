import { NextResponse, type NextRequest } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { statusForDbError, dbErrorBody } from '@/lib/errors'

export const runtime = 'nodejs'

const VERDICTS = {
  approve: 'approved',
  reject: 'rejected',
  undo: 'pending',
} as const

/**
 * Record a verdict, or take one back.
 *
 * This route decides nothing. Every rule §7 describes — the reviewer is not
 * the submitter, the photo has arrived, the claim is inside the finality
 * window, only the original rejector or an admin may undo — is enforced by the
 * claims_review policy and the update guard trigger. All that happens here is
 * a status change, and whatever the database says about it is reported.
 *
 * The reviewer stamp and the entry in claim_review_events are written by
 * trigger, so no code path can record a verdict without also recording who
 * cast it.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  }

  let body: { claimId?: unknown; action?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 })
  }

  const action = body.action
  if (typeof action !== 'string' || !(action in VERDICTS)) {
    return NextResponse.json(
      { error: 'action must be approve, reject or undo' },
      { status: 400 },
    )
  }
  if (typeof body.claimId !== 'string') {
    return NextResponse.json({ error: 'claimId is required' }, { status: 400 })
  }

  // Undo on a claim that is already pending hits the guard's "status did not
  // change" early return: nothing happens, nothing is logged, and the row
  // comes back looking like a success. Refuse it here rather than report an
  // action that did not occur.
  if (action === 'undo') {
    const { data: current } = await supabase
      .from('claims')
      .select('status')
      .eq('id', body.claimId)
      .single()
    if (current && current.status !== 'rejected') {
      return NextResponse.json(
        { error: 'that claim is not rejected, so there is nothing to undo' },
        { status: 409 },
      )
    }
  }

  const { data, error } = await supabase
    .from('claims')
    .update({ status: VERDICTS[action as keyof typeof VERDICTS] })
    .eq('id', body.claimId)
    .select('id, number, status')

  if (error) {
    return NextResponse.json(dbErrorBody(error), { status: statusForDbError(error) })
  }

  // An UPDATE whose policy excludes the row matches zero rows rather than
  // raising. That is not success: it means this claim was not the caller's to
  // act on, or is no longer in a state where the action applies.
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: 'that claim is not yours to review, or has already been decided' },
      { status: 403 },
    )
  }

  return NextResponse.json({ claim: data[0] })
}
