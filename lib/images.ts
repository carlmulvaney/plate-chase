import 'server-only'

import sharp from 'sharp'
import heicConvert from 'heic-convert'

/**
 * Display derivatives.
 *
 * iPhones shoot HEIC by default and browsers cannot render it, so the review
 * screen would show nothing for most real submissions. The original stays
 * untouched in the originals bucket as the evidence of record; this produces
 * the thing people actually look at.
 *
 * Everything here is regenerable from the original, which is why a failure to
 * produce it is logged rather than failing the claim.
 */

const MAX_EDGE = 2000

export type Derivative = {
  bytes: Uint8Array
  contentType: 'image/jpeg'
}

export async function buildDisplayImage(original: Uint8Array): Promise<Derivative> {
  let input = original

  // Decode HEIC with heic-convert rather than sharp. libvips reports HEIF
  // input support, but its decoder fails on real iPhone files — it seeks past
  // the end of the buffer ("bad seek to <n>") on a file heic-convert handles
  // without complaint.
  if (isHeicBytes(original)) {
    input = await heicConvert({ buffer: original, format: 'JPEG', quality: 0.9 })
  }

  const bytes = await sharp(input)
    // Honour the EXIF orientation flag, then drop metadata: the derivative is
    // for looking at, and the original remains the record of what was shot.
    .rotate()
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer()

  return { bytes: new Uint8Array(bytes), contentType: 'image/jpeg' }
}

/**
 * Detect HEIC from the file's own bytes, not its Content-Type.
 *
 * Content-Type is not trustworthy here: browsers frequently report an empty
 * `File.type` for `.heic`, the upload then falls back to
 * `application/octet-stream`, and that is what R2 stores. Sniffing the
 * container is authoritative and costs nothing.
 *
 * An ISO base media file carries `ftyp` at offset 4 and its brand at offset 8.
 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

function isHeicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end))
  if (ascii(4, 8) !== 'ftyp') return false
  return HEIC_BRANDS.has(ascii(8, 12))
}
