import { NextResponse, type NextRequest } from 'next/server'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { createClient } from '@/lib/supabase/server'
import { r2, R2_BUCKET_ORIGINALS } from '@/lib/r2'
import { buildPhotoKey } from '@/lib/photo-keys'
import { normalisePlate, trailingNumber } from '@/lib/plate'
import { statusForDbError, dbErrorBody } from '@/lib/errors'

export const runtime = 'nodejs'

/**
 * Step 1 of the handshake: claim a slot.
 *
 * Creates the claims row with uploaded_at null and hands back a presigned PUT.
 * The row existing before the upload is what gives orphan cleanup a handle —
 * any claim with uploaded_at null and no photo can be swept later.
 *
 * This route deliberately does not check the plate format or the target. The
 * check constraint and the rule-2 trigger do that, and their refusal is what
 * we report. A second copy of those rules here would be a second set of rules.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  }

  let body: { plate?: unknown; filename?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 })
  }

  if (typeof body.plate !== 'string') {
    return NextResponse.json({ error: 'plate is required' }, { status: 400 })
  }

  const plate = normalisePlate(body.plate)
  const number = trailingNumber(plate)

  // Not a rule check. A plate whose last three characters are not digits gives
  // us no number to insert, so there is no row to hand the database. Anything
  // else — including a badly shaped plate — goes in and is refused by the
  // check constraint, in the constraint's own words.
  if (number === null) {
    return NextResponse.json(
      { error: `"${plate}" does not end in three digits, so it claims no target` },
      { status: 422 },
    )
  }

  const filename = typeof body.filename === 'string' ? body.filename : 'photo.jpg'
  const photoKey = buildPhotoKey(auth.user.id, number, filename)

  const { data: claim, error } = await supabase
    .from('claims')
    .insert({ player_id: auth.user.id, number, plate, photo_key: photoKey })
    .select('id, number, plate, photo_key')
    .single()

  if (error) {
    // Read the target back from the view rather than reasoning about it here.
    // v_player_state is the single definition of next_target; recomputing it
    // to write a nicer sentence would be a second definition.
    const { data: state } = await supabase
      .from('v_player_state')
      .select('next_target')
      .eq('player_id', auth.user.id)
      .single()

    return NextResponse.json(
      dbErrorBody(error, {
        plate,
        claimedNumber: number,
        nextTarget: state?.next_target ?? null,
      }),
      { status: statusForDbError(error) },
    )
  }

  const uploadUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({ Bucket: R2_BUCKET_ORIGINALS, Key: photoKey }),
    { expiresIn: 15 * 60 },
  )

  return NextResponse.json({
    claimId: claim.id,
    number: claim.number,
    plate: claim.plate,
    uploadUrl,
  })
}
