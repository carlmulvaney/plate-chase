/**
 * Fixture players and claims, for review-screen states that cannot otherwise
 * be reached in a browser.
 *
 *   node --env-file=.env scripts/seed-fixtures.mjs                      # dry run
 *   node --env-file=.env scripts/seed-fixtures.mjs --project <ref> --confirm
 *   node --env-file=.env scripts/seed-fixtures.mjs --remove --project <ref> --confirm
 *
 * What it creates, and why each one exists:
 *
 *   - a claim backdated past the finality window, so Reject is disabled and
 *     the card says why. The window bounds rejection only; nothing in normal
 *     use produces a claim old enough to show it.
 *   - a claim whose display derivative is deleted, so the "no viewable copy"
 *     state renders. Otherwise it needs a real transcode failure.
 *   - a claim rejected by someone who is not you, so the Rejections list shows
 *     "not yours to undo" — the can_undo = false branch.
 *   - a second submitter, so the queue holds claims from more than one player.
 *
 * Fixture accounts are identified by their email domain, not by name, so
 * --remove can find every one of them and nothing else.
 *
 * This runs against the project SUPABASE_DB_URL names, and there is no
 * separate development project — so it is pointed at production. Same guards
 * as reset-claims: --project must match the project the connection string
 * actually reaches, and nothing happens without --confirm.
 *
 * Run --remove before real players sign up. Anything left behind appears on
 * the leaderboard beside them.
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'
import pg from 'pg'
import { randomUUID } from 'node:crypto'

const FIXTURE_DOMAIN = '@plate-chase.test'

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const remove = args.includes('--remove')
const wanted = args[args.indexOf('--project') + 1]
const named = args.includes('--project') && wanted && !wanted.startsWith('--')

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error('SUPABASE_DB_URL is not set — run with: node --env-file=.env scripts/seed-fixtures.mjs')
  process.exit(1)
}

const parsed = new URL(url.replace(/^postgresql:/, 'http:'))
const actual = decodeURIComponent(parsed.username).split('.')[1] ?? '(unknown)'
console.log(`project: ${actual}`)
console.log(`host:    ${parsed.hostname}`)
console.log(`mode:    ${remove ? 'remove fixtures' : 'create fixtures'}\n`)

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
const BUCKETS = [process.env.R2_BUCKET_ORIGINALS, process.env.R2_BUCKET_DISPLAY]

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await db.connect()

const { rows: fixtures } = await db.query(
  `select u.id, u.email, p.display_name
     from auth.users u join players p on p.id = u.id
    where u.email like $1
    order by u.email`,
  [`%${FIXTURE_DOMAIN}`],
)
const { rows: fixtureClaims } = await db.query(
  `select c.id, c.number, c.plate, c.photo_key, c.status, p.display_name
     from claims c join players p on p.id = c.player_id
     join auth.users u on u.id = c.player_id
    where u.email like $1
    order by p.display_name, c.number`,
  [`%${FIXTURE_DOMAIN}`],
)

console.log(`fixture accounts (${FIXTURE_DOMAIN}): ${fixtures.length}`)
for (const f of fixtures) console.log(`   ${f.display_name.padEnd(10)} ${f.email}`)
console.log(`their claims: ${fixtureClaims.length}`)
for (const c of fixtureClaims) {
  console.log(`   ${c.display_name.padEnd(10)} ${String(c.number).padStart(3, '0')}  ${c.plate}  ${c.status}`)
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------
if (remove) {
  if (!confirm) {
    console.log(`\nDry run. To remove all of the above:`)
    console.log(`  node --env-file=.env scripts/seed-fixtures.mjs --remove --project ${actual} --confirm`)
    await db.end()
    process.exit(0)
  }

  console.log('\nremoving…')
  const ids = fixtures.map((f) => f.id)

  // A fixture player may have rejected someone else's claim. claims.reviewed_by
  // references players, so those verdicts have to be undone before the player
  // can go — and undoing them is the right outcome anyway: a rejection by an
  // account that no longer exists should not keep costing anyone their streak.
  await db.query('alter table claims disable trigger trg_claims_before_update_guard')
  await db.query('alter table claims disable trigger trg_claims_after_status_change_log')
  try {
    const freed = await db.query(
      `update claims set status = 'pending', reviewed_by = null, reviewed_at = null
        where reviewed_by = any($1::uuid[])`,
      [ids],
    )
    if (freed.rowCount > 0) {
      console.log(`  ${freed.rowCount} claim(s) reviewed by a fixture account returned to pending`)
    }
  } finally {
    await db.query('alter table claims enable trigger trg_claims_before_update_guard')
    await db.query('alter table claims enable trigger trg_claims_after_status_change_log')
  }

  const keys = fixtureClaims.map((c) => c.photo_key)
  await db.query(
    `delete from claim_review_events
      where actor_id = any($1::uuid[]) or claim_id in (select id from claims where player_id = any($1::uuid[]))`,
    [ids],
  )
  const gone = await db.query('delete from claims where player_id = any($1::uuid[])', [ids])
  console.log(`  ${gone.rowCount} claim(s) deleted`)

  for (const Bucket of BUCKETS) {
    if (keys.length === 0) continue
    await r2
      .send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }))
      .catch(() => {})
    console.log(`  ${Bucket}: up to ${keys.length} object(s) deleted`)
  }

  // players.id references auth.users on delete cascade, so this takes both.
  const users = await db.query('delete from auth.users where id = any($1::uuid[])', [ids])
  console.log(`  ${users.rowCount} fixture account(s) deleted`)

  await report(db)
  await db.end()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
if (!confirm) {
  console.log(`\nDry run. To create the fixtures:`)
  console.log(`  node --env-file=.env scripts/seed-fixtures.mjs --project ${actual} --confirm`)
  await db.end()
  process.exit(0)
}

async function plateImage(text, tint) {
  const svg = `<svg width="900" height="500" xmlns="http://www.w3.org/2000/svg">
    <rect width="900" height="500" fill="${tint}"/>
    <rect x="120" y="150" width="660" height="220" rx="24" fill="#f6f6f0" stroke="#12305a" stroke-width="8"/>
    <text x="450" y="205" font-family="Helvetica,Arial" font-size="34" fill="#12305a"
          text-anchor="middle" letter-spacing="4">CALIFORNIA</text>
    <text x="450" y="315" font-family="Helvetica,Arial" font-size="96" font-weight="bold"
          fill="#12305a" text-anchor="middle" letter-spacing="10">${text}</text>
    <text x="450" y="440" font-family="Helvetica,Arial" font-size="22" fill="#c9d6e5"
          text-anchor="middle">fixture — not a real vehicle</text>
  </svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer()
}

console.log('\ncreating…')

const REX = 'rex@plate-chase.test'
let { rows: existing } = await db.query('select id from auth.users where email = $1', [REX])
let rexId = existing[0]?.id
if (!rexId) {
  rexId = randomUUID()
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data)
     values ($1, $2, jsonb_build_object('display_name', 'Rex'::text))`,
    [rexId, REX],
  )
  console.log(`  created ${REX}`)
} else {
  console.log(`  ${REX} already exists`)
}

const { rows: [rexState] } = await db.query(
  'select next_target from v_player_state where player_id = $1',
  [rexId],
)
let target = rexState.next_target
const base = new Date('2026-08-25T14:00:00Z')

// Three claims, each existing to render one state.
const plan = [
  { note: 'backdated past the finality window — Reject disabled', backdate: true, dropDisplay: false },
  { note: 'display derivative deleted — "no viewable copy"', backdate: false, dropDisplay: true },
  { note: 'ordinary, so the queue holds more than one submitter', backdate: false, dropDisplay: false },
]

const created = []
for (const [i, step] of plan.entries()) {
  const number = target + i
  const padded = String(number).padStart(3, '0')
  const plate = `${(i + 2) % 10}Rex${padded}`.toUpperCase()
  const key = `${rexId}/${padded}/${randomUUID()}.jpeg`
  const bytes = await plateImage(plate, '#3f5f3f')

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_ORIGINALS,
      Key: key,
      Body: bytes,
      ContentType: 'image/jpeg',
    }),
  )
  if (!step.dropDisplay) {
    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_DISPLAY,
        Key: key,
        Body: bytes,
        ContentType: 'image/jpeg',
      }),
    )
  }

  await db.query(
    `insert into claims (player_id, number, plate, photo_key, uploaded_at, captured_at)
     values ($1, $2, $3, $4, now(), $5)`,
    [rexId, number, plate, key, new Date(base.valueOf() + i * 20 * 3_600_000).toISOString()],
  )
  created.push({ number, plate, key, ...step })
  console.log(`  ${padded}  ${plate}  ${step.note}`)
}

// created_at is immutable to the guard — rightly, it is evidence — so ageing a
// fixture past the window means standing the trigger aside for one statement.
const toAge = created.filter((c) => c.backdate).map((c) => c.number)
if (toAge.length > 0) {
  await db.query('alter table claims disable trigger trg_claims_before_update_guard')
  try {
    await db.query(
      `update claims set created_at = now() - interval '30 days'
        where player_id = $1 and number = any($2::int[])`,
      [rexId, toAge],
    )
  } finally {
    await db.query('alter table claims enable trigger trg_claims_before_update_guard')
  }
  console.log(`  aged ${toAge.length} claim(s) to 30 days old`)
}

// One claim rejected by Rex, so the Rejections list has an entry the signed-in
// player may not undo.
const { rows: victims } = await db.query(
  `select c.id, c.number from claims c
     join auth.users u on u.id = c.player_id
    where c.status = 'pending' and c.player_id <> $1 and u.email not like $2
    order by c.number desc limit 1`,
  [rexId, `%${FIXTURE_DOMAIN}`],
)
const victim = victims[0] ?? (
  await db.query(
    `select c.id, c.number from claims c
      where c.status = 'pending' and c.player_id <> $1 order by c.number desc limit 1`,
    [rexId],
  )
).rows[0]

if (victim) {
  // Both triggers stand aside: the guard because a verdict needs a signed-in
  // reviewer and there is none over a direct connection, and the log because
  // it would take actor_id from that same absent auth.uid() and fail NOT NULL.
  // The log entry is then written by hand with Rex as the actor, so the audit
  // trail says what actually happened rather than nothing at all.
  await db.query('alter table claims disable trigger trg_claims_before_update_guard')
  await db.query('alter table claims disable trigger trg_claims_after_status_change_log')
  try {
    await db.query(
      `update claims set status = 'rejected', reviewed_by = $1, reviewed_at = now() where id = $2`,
      [rexId, victim.id],
    )
    await db.query(
      `insert into claim_review_events (claim_id, actor_id, action, note)
       values ($1, $2, 'reject', 'fixture')`,
      [victim.id, rexId],
    )
  } finally {
    await db.query('alter table claims enable trigger trg_claims_before_update_guard')
    await db.query('alter table claims enable trigger trg_claims_after_status_change_log')
  }
  console.log(`  ${String(victim.number).padStart(3, '0')} rejected by Rex — "not yours to undo"`)
} else {
  console.log('  (no claim available to reject, so the can_undo=false state was not set up)')
}

await report(db)
await db.end()

async function report(client) {
  const { rows } = await client.query(
    'select display_name, next_target, confirmed_count, pending_count from v_player_state order by display_name',
  )
  console.log('\nplayers:')
  for (const p of rows) {
    console.log(
      `  ${p.display_name.padEnd(10)} next_target ${String(p.next_target).padStart(3, '0')}  confirmed ${p.confirmed_count}  pending ${p.pending_count}`,
    )
  }
}
