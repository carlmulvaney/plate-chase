import sharp from 'sharp'
import heicConvert from 'heic-convert'

/**
 * Turning an original into the copy a browser can render.
 *
 * Kept free of `server-only` so scripts can import it too — it is the same
 * pipeline whether it runs in a route or in scripts/rebuild-derivatives.mjs,
 * and a second copy would drift. App code should import `@/lib/images`, which
 * re-exports this behind that guard.
 */

const MAX_EDGE = 2000

export type Derivative = {
  bytes: Uint8Array
  contentType: 'image/jpeg'
}

/**
 * HEIC detected from the file's own bytes rather than its Content-Type.
 * Browsers frequently report an empty `File.type` for .heic, so the upload
 * falls back to application/octet-stream and that is what R2 stores. An ISO
 * base media file carries `ftyp` at offset 4 and its brand at offset 8.
 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

export function isHeicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end))
  return ascii(4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(8, 12))
}

export async function buildDisplayImage(original: Uint8Array): Promise<Derivative> {
  // heic-convert rather than sharp: libvips reports HEIF input support but its
  // decoder seeks past the end of the buffer on real iPhone files.
  const input = isHeicBytes(original)
    ? await heicConvert({ buffer: original, format: 'JPEG', quality: 0.9 })
    : original

  const bytes = await sharp(input)
    // Honour the EXIF orientation flag, then drop metadata — the derivative is
    // for looking at, and the original remains the record of what was shot.
    // Dropping it also keeps GPS out of the file browsers download.
    .rotate()
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer()

  return { bytes: new Uint8Array(bytes), contentType: 'image/jpeg' }
}
