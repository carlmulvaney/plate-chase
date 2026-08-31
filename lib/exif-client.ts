// The lite browser build, not the default entry. The full build reaches for
// Node's fs and zlib, which Turbopack reports as "Couldn't load fs" while
// bundling this for the browser, and drags in readers we have no use for.
// Lite covers TIFF/EXIF, which is where DateTimeOriginal lives.
import exifr from 'exifr/dist/lite.esm.mjs'

/**
 * Reads a capture time in the browser, to order a list. Nothing more.
 *
 * B3 in docs/design/bulk-upload.md. This is deliberately NOT the value rule 4
 * is enforced on — the server reads EXIF from the uploaded original, exactly as
 * before, and the database decides. A browser that reads nothing, or reads
 * something wrong, can therefore produce a badly ordered list, which the player
 * can drag straight, but can never produce a wrong verdict.
 *
 * It never modifies the file. The bytes uploaded are still the bytes the camera
 * produced.
 */
export async function readCaptureTimeForSorting(file: File): Promise<number | null> {
  try {
    const parsed = await exifr.parse(file, {
      tiff: true,
      exif: true,
      pick: ['DateTimeOriginal', 'CreateDate'],
    })
    const raw = parsed?.DateTimeOriginal ?? parsed?.CreateDate
    if (raw instanceof Date && !Number.isNaN(raw.valueOf())) return raw.valueOf()
    return null
  } catch {
    // No readable EXIF, an unsupported container, a browser quirk — all the
    // same answer here: we have no opinion about where this photo belongs.
    return null
  }
}

/**
 * Oldest first, with photos that carry no capture time left where the player
 * put them, after the ones that do (B3a). A stable sort, so equal times and
 * unknown times keep their relative order.
 */
export function sortByCaptureTime<T extends { capturedAt: number | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.capturedAt === null && b.capturedAt === null) return 0
    if (a.capturedAt === null) return 1
    if (b.capturedAt === null) return -1
    return a.capturedAt - b.capturedAt
  })
}
