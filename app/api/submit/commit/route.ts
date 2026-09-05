import { NextResponse, type NextRequest } from 'next/server'
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

import { createClient } from '@/lib/supabase/server'
import { r2, R2_BUCKET_ORIGINALS, R2_BUCKET_DISPLAY } from '@/lib/r2'
import { readPhotoMetadata } from '@/lib/exif'
import { buildDisplayImage } from '@/lib/images'
import { statusForDbError, dbErrorBody } from '@/lib/errors'

export const runtime = 'nodejs'

/**
 * Steps 3 and 4 of the handshake: the upload is done, so read the object back,
 * stamp what it says, and let the database judge the ordering.
 *
 * Writing captured_at is what fires the rule-4 trigger. This is the earliest
 * moment that rule can be checked at all — the capture time does not exist
 * until now — which is why the check lives on UPDATE rather than INSERT.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  }

  let body: { claimId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 })
  }
  if (typeof body.claimId !== 'string') {
    return NextResponse.json({ error: 'claimId is required' }, { status: 400 })
  }

  // RLS restricts this to the caller's own claims.
  const { data: claim, error: readError } = await supabase
    .from('claims')
    .select('id, player_id, number, photo_key, uploaded_at')
    .eq('id', body.claimId)
    .single()

  if (readError || !claim) {
    return NextResponse.json({ error: 'claim not found' }, { status: 404 })
  }
  if (claim.player_id !== auth.user.id) {
    return NextResponse.json({ error: 'not your claim' }, { status: 403 })
  }
  if (claim.uploaded_at) {
    return NextResponse.json({ error: 'already confirmed' }, { status: 409 })
  }

  // --- fetch the original back ------------------------------------------
  let original: Uint8Array
  try {
    const object = await r2.send(
      new GetObjectCommand({ Bucket: R2_BUCKET_ORIGINALS, Key: claim.photo_key }),
    )
    if (!object.Body) throw new Error('empty body')
    original = await object.Body.transformToByteArray()
  } catch {
    return NextResponse.json(
      { error: 'no photo found for this claim — did the upload finish?' },
      { status: 422 },
    )
  }

  // --- EXIF --------------------------------------------------------------
  const meta = await readPhotoMetadata(original)

  // --- stamp it, which is where rule 4 fires -----------------------------
  const { error: stampError } = await supabase
    .from('claims')
    .update({
      uploaded_at: new Date().toISOString(),
      captured_at: meta.capturedAt?.toISOString() ?? null,
      gps_lat: meta.lat,
      gps_lon: meta.lon,
    })
    .eq('id', claim.id)

  if (stampError) {
    // Rule 4 refused, so this claim never reaches review. Take the row and the
    // object with it: the decision on record is that a failing claim leaves
    // nothing behind, and the orphan sweep should not have to clean up after
    // a rule we already know refused.
    await supabase.from('claims').delete().eq('id', claim.id)
    await r2
      .send(new DeleteObjectCommand({ Bucket: R2_BUCKET_ORIGINALS, Key: claim.photo_key }))
      .catch(() => {})

    return NextResponse.json(dbErrorBody(stampError), {
      status: statusForDbError(stampError),
    })
  }

  // --- display derivative ------------------------------------------------
  // Non-fatal by design: the claim is already valid and recorded, and anything
  // in the display bucket can be regenerated from the original at any time.
  try {
    const derivative = await buildDisplayImage(original)
    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_DISPLAY,
        Key: claim.photo_key,
        Body: derivative.bytes,
        ContentType: derivative.contentType,
      }),
    )
  } catch (e) {
    console.error(`display derivative failed for claim ${claim.id}:`, e)
  }

  return NextResponse.json({
    claimId: claim.id,
    number: claim.number,
    capturedAt: meta.capturedAt?.toISOString() ?? null,
    hasLocation: meta.lat !== null,
    // Surfaced so the UI can say so plainly: a claim with no capture time is
    // not in trouble, it just needs a human to judge the ordering.
    needsHumanOrdering: meta.capturedAt === null,
  })
}
