import 'server-only'

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { r2, R2_BUCKET_DISPLAY } from '@/lib/r2'

/**
 * A short-lived URL for looking at a claim's photo.
 *
 * Neither bucket is public, and neither should be: originals carry GPS in
 * their EXIF, and this is a game about photographing plates near where people
 * live. Every view is a URL minted server-side for one object, valid for a
 * few minutes.
 *
 * The display derivative, not the original — it is already transcoded, so it
 * renders on a phone at all, and resized, so it arrives before the reviewer
 * gives up.
 */
export function displayPhotoUrl(photoKey: string, expiresIn = 10 * 60): Promise<string> {
  return getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: R2_BUCKET_DISPLAY, Key: photoKey }),
    { expiresIn },
  )
}

/**
 * The same URL, or null when there is no derivative to point at.
 *
 * The confirm step treats a failed transcode as non-fatal — the claim is valid
 * and the original is safe — which left the review screen rendering a broken
 * image with live verdict buttons under it. Seeing the photo is the entire
 * point of that screen, so the absence has to be reported rather than
 * discovered by the browser.
 */
export async function displayPhotoUrlIfPresent(photoKey: string): Promise<string | null> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET_DISPLAY, Key: photoKey }))
  } catch {
    return null
  }
  return displayPhotoUrl(photoKey)
}
