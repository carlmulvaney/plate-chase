/**
 * Delete every claim and every photo, so testing can start from 000 again.
 *
 *   node --env-file=.env scripts/reset-claims.mjs                    # dry run
 *   node --env-file=.env scripts/reset-claims.mjs --project <ref> --confirm
 *
 * This is pointed at whatever SUPABASE_DB_URL names, and there is currently no
 * separate development project — so in practice it is pointed at production.
 * Two guards, both deliberate:
 *
 *   --project <ref>  must match the project the connection string actually
 *                    reaches. Copying this command into a shell with a
 *                    different .env then deletes nothing.
 *   --confirm        without it, nothing is deleted; it prints what it would
 *                    remove and stops.
 *
 * What it removes: claim_review_events, claims, and every object in both R2
 * buckets. What it leaves: players, auth.users (so you stay signed in),
 * app_config, and schema_migrations.
 *
 * There is no undo. The photos are gone, not archived.
 */

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import pg from 'pg'

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const wanted = args[args.indexOf('--project') + 1]
const named = args.includes('--project') && wanted && !wanted.startsWith('--')

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error('SUPABASE_DB_URL is not set — run with: node --env-file=.env scripts/reset-claims.mjs')
  process.exit(1)
}

// The pooler username is postgres.<project-ref>; that is the project this
// connection string genuinely reaches, whatever anyone believes it points at.
const parsed = new URL(url.replace(/^postgresql:/, 'http:'))
const actual = decodeURIComponent(parsed.username).split('.')[1] ?? '(unknown)'

console.log(`project: ${actual}`)
console.log(`host:    ${parsed.hostname}\n`)

if (confirm && (!named || wanted !== actual)) {
  console.error(
    named
      ? `refusing: --project ${wanted} does not match ${actual}, which is what this connection string reaches`
      : `refusing: --confirm requires --project ${actual}, so the target is stated rather than assumed`,
  )
  process.exit(1)
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await db.connect()

const { rows: claims } = await db.query(
  'select number, plate, status from claims order by number',
)
const { rows: [{ n: events }] } = await db.query(
  'select count(*)::int n from claim_review_events',
)

const buckets = [process.env.R2_BUCKET_ORIGINALS, process.env.R2_BUCKET_DISPLAY]
const objects = {}
for (const bucket of buckets) {
  const out = await r2.send(new ListObjectsV2Command({ Bucket: bucket }))
  objects[bucket] = (out.Contents ?? []).map((o) => o.Key)
}

console.log(`claims:              ${claims.length}`)
for (const c of claims) {
  console.log(`   ${String(c.number).padStart(3, '0')}  ${c.plate}  ${c.status}`)
}
console.log(`claim_review_events: ${events}`)
for (const bucket of buckets) console.log(`${bucket}: ${objects[bucket].length} object(s)`)

if (!confirm) {
  console.log(`\nDry run. To delete all of the above:`)
  console.log(`  node --env-file=.env scripts/reset-claims.mjs --project ${actual} --confirm`)
  await db.end()
  process.exit(0)
}

console.log('\ndeleting…')
await db.query('delete from claim_review_events')
const deleted = await db.query('delete from claims')
console.log(`  claims: ${deleted.rowCount} deleted`)

for (const bucket of buckets) {
  const keys = objects[bucket]
  if (keys.length === 0) continue
  // DeleteObjects takes up to 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    await r2.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
      }),
    )
  }
  console.log(`  ${bucket}: ${keys.length} object(s) deleted`)
}

const { rows: state } = await db.query(
  'select display_name, next_target from v_player_state order by display_name',
)
console.log()
for (const s of state) {
  console.log(`target is now ${String(s.next_target).padStart(3, '0')} for ${s.display_name}`)
}
await db.end()
