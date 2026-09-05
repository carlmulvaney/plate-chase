/**
 * Rebuild missing display copies, and report claims whose original is gone.
 *
 *   node --env-file=.env scripts/rebuild-derivatives.mjs            # dry run
 *   node --env-file=.env scripts/rebuild-derivatives.mjs --confirm
 *
 * The confirm step treats a failed transcode as non-fatal, on the grounds that
 * a display copy is derivable from the original at any time. This is what
 * makes that true. Without it the claim shows NO PHOTO on the review screen
 * and nothing ever repairs it.
 *
 * Deliberately a script rather than something the review page does on demand.
 * A page that repairs what it reads writes on every GET, transcodes while
 * someone waits for it, and hides how often the failure happens — the count
 * this prints is the only signal that a transcode problem exists at all.
 *
 * No --project guard: this only ever adds objects that should already be
 * there, and deletes nothing.
 */

import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import pg from 'pg'

// The same pipeline the app uses, not a copy of it. lib/images.ts is the
// guarded entry point for app code; this reaches past it because 'server-only'
// cannot be imported outside Next.
import { buildDisplayImage } from '../lib/image-pipeline.ts'

const confirm = process.argv.includes('--confirm')

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const { rows: claims } = await db.query(
  `select c.id, c.number, c.plate, c.photo_key, p.display_name
     from claims c join players p on p.id = c.player_id
    where c.uploaded_at is not null
    order by p.display_name, c.number`,
)
await db.end()

const has = async (Bucket, Key) => {
  try {
    await r2.send(new HeadObjectCommand({ Bucket, Key }))
    return true
  } catch {
    return false
  }
}

const missing = []
const orphaned = []

for (const claim of claims) {
  if (await has(process.env.R2_BUCKET_DISPLAY, claim.photo_key)) continue
  if (await has(process.env.R2_BUCKET_ORIGINALS, claim.photo_key)) {
    missing.push(claim)
  } else {
    orphaned.push(claim)
  }
}

const label = (c) => `${c.display_name} ${String(c.number).padStart(3, '0')} ${c.plate}`

console.log(`claims with a photo: ${claims.length}`)
console.log(`display copy missing, original present: ${missing.length}`)
for (const c of missing) console.log(`   ${label(c)}`)
console.log(`original missing too: ${orphaned.length}`)
for (const c of orphaned) console.log(`   ${label(c)}   <- no evidence at all`)

if (orphaned.length > 0) {
  console.log(
    `\nThose ${orphaned.length} cannot be rebuilt: the original is what everything else is` +
      `\nderived from. They will show NO PHOTO on the review screen, and a reviewer` +
      `\njudging them is judging the absence of evidence.`,
  )
}

if (missing.length === 0) {
  console.log('\nnothing to rebuild')
  process.exit(0)
}

if (!confirm) {
  console.log(`\nDry run. To rebuild the ${missing.length} above:`)
  console.log('  node --env-file=.env scripts/rebuild-derivatives.mjs --confirm')
  process.exit(0)
}

console.log('\nrebuilding…')
let rebuilt = 0
for (const claim of missing) {
  try {
    const object = await r2.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_ORIGINALS, Key: claim.photo_key }),
    )
    const original = await object.Body.transformToByteArray()
    const { bytes } = await buildDisplayImage(original)
    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_DISPLAY,
        Key: claim.photo_key,
        Body: bytes,
        ContentType: 'image/jpeg',
      }),
    )
    console.log(
      `   ${label(claim)}  ${(original.length / 1024).toFixed(0)} KB -> ${(bytes.length / 1024).toFixed(0)} KB`,
    )
    rebuilt++
  } catch (e) {
    console.error(`   ${label(claim)}  FAILED: ${e.message}`)
  }
}
console.log(`\n${rebuilt} of ${missing.length} rebuilt`)
process.exit(rebuilt === missing.length ? 0 : 1)
