/**
 * Apply supabase/migrations/*.sql to the database in SUPABASE_DB_URL.
 *
 *   node --env-file=.env scripts/db.mjs          # show what would run
 *   node --env-file=.env scripts/db.mjs --apply  # run what is pending
 *
 * Applied migrations are recorded in schema_migrations, so this is safe to run
 * repeatedly against a live project: only pending files execute. Each runs
 * inside its own transaction, together with its ledger row, so a migration
 * that fails halfway leaves neither schema changes nor a false record of
 * having been applied.
 *
 * The ledger also stores each file's sha256 and re-checks it. Migrations are
 * forward-only; editing one that has already run is how two databases end up
 * claiming the same version while holding different schemas, and this refuses
 * to continue when it sees that.
 *
 * Only supabase/migrations/ is ever read. supabase/tests/ is deliberately out
 * of reach: _local_stub.sql redefines auth.uid(), and applying that to a live
 * project makes every RLS policy evaluate false while the app still looks
 * healthy.
 */

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import pg from 'pg'

const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations')
const apply = process.argv.includes('--apply')

const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()
if (files.length === 0) {
  console.log('no migrations found in supabase/migrations/')
  process.exit(0)
}

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error('SUPABASE_DB_URL is not set — run with: node --env-file=.env scripts/db.mjs')
  process.exit(1)
}

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
})
await client.connect()

const { rows: [v] } = await client.query('select version() as v')
console.log(v.v.split(',')[0])
console.log(`target: ${new URL(url.replace(/^postgresql:/, 'http:')).hostname}\n`)

await client.query(`
  create table if not exists schema_migrations (
    filename   text primary key,
    sha256     text not null,
    applied_at timestamptz not null default now()
  )
`)

const { rows: ledger } = await client.query('select filename, sha256 from schema_migrations')
const applied = new Map(ledger.map((r) => [r.filename, r.sha256]))

let pending = 0
let drift = false

for (const file of files) {
  const sql = await readFile(path.join(MIGRATIONS, file), 'utf8')
  const sha = createHash('sha256').update(sql).digest('hex')
  const previous = applied.get(file)

  if (previous) {
    if (previous === sha) {
      console.log(`${file}\n  already applied\n`)
    } else {
      drift = true
      console.error(`${file}`)
      console.error(`  ALREADY APPLIED, BUT THE FILE HAS CHANGED`)
      console.error(`    recorded ${previous}`)
      console.error(`    on disk  ${sha}`)
      console.error(`  Migrations are forward-only. Add a new migration instead.\n`)
    }
    continue
  }

  pending++
  console.log(`${file}`)
  console.log(`  sha256 ${sha}`)

  if (!apply) {
    console.log('  pending (pass --apply to execute)\n')
    continue
  }

  try {
    await client.query('begin')
    await client.query(sql)
    await client.query('insert into schema_migrations (filename, sha256) values ($1, $2)', [
      file,
      sha,
    ])
    await client.query('commit')
    console.log('  applied\n')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    console.error(`  FAILED, rolled back: ${e.message}`)
    if (e.position) console.error(`  at character ${e.position}`)
    await client.end()
    process.exit(1)
  }
}

if (pending === 0) console.log('nothing pending')
await client.end()
process.exit(drift ? 1 : 0)
