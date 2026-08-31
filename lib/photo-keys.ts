import { randomUUID } from 'node:crypto'

/**
 * R2 object keys: `<player>/<target>/<uuid>.<ext>`
 *
 * Browsable by player and by target in the R2 dashboard, which is what you
 * want when inspecting a disputed claim by hand. The uuid keeps a re-claim
 * after a rejection from colliding with the object it replaces — nothing in
 * the evidence bucket is ever overwritten.
 *
 * The same key is used in both buckets: the original in ORIGINALS, its
 * display derivative in DISPLAY.
 */
export function buildPhotoKey(playerId: string, target: number, filename: string): string {
  const ext = extensionFor(filename)
  const padded = target.toString().padStart(3, '0')
  return `${playerId}/${padded}/${randomUUID()}${ext}`
}

const ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp'])

function extensionFor(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return '.jpg'
  const ext = filename.slice(dot).toLowerCase()
  return ALLOWED.has(ext) ? ext : '.jpg'
}
