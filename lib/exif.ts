import 'server-only'

import exifr from 'exifr'

/**
 * EXIF is read here — server-side, from the uploaded original — and nowhere
 * else. One code path, immune to mobile browser quirks, and re-derivable later
 * if a claim is ever disputed.
 *
 * This is also why the browser uploads the untouched file: any in-browser
 * resize or canvas round-trip strips the capture time that rule 4 depends on.
 */

export type PhotoMetadata = {
  /** When the photo was taken. Null when the file carries no capture time. */
  capturedAt: Date | null
  lat: number | null
  lon: number | null
}

export async function readPhotoMetadata(bytes: Uint8Array): Promise<PhotoMetadata> {
  let parsed: Record<string, unknown> | undefined

  try {
    parsed = await exifr.parse(bytes, {
      tiff: true,
      exif: true,
      gps: true,
      // Prefer the original capture time over any later modification stamp.
      pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'],
    })
  } catch {
    // A file with no readable EXIF is not an error. Missing capture time is a
    // question for a human, not a rejection — see spec §5.
    return { capturedAt: null, lat: null, lon: null }
  }

  if (!parsed) return { capturedAt: null, lat: null, lon: null }

  const raw = parsed.DateTimeOriginal ?? parsed.CreateDate
  const capturedAt = raw instanceof Date && !Number.isNaN(raw.valueOf()) ? raw : null

  const lat = typeof parsed.latitude === 'number' ? parsed.latitude : null
  const lon = typeof parsed.longitude === 'number' ? parsed.longitude : null

  // The schema stores a coordinate as a pair or not at all.
  const hasPair = lat !== null && lon !== null

  return {
    capturedAt,
    lat: hasPair ? lat : null,
    lon: hasPair ? lon : null,
  }
}
