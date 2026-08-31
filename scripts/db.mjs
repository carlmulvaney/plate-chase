/**
 * Apply supabase/migrations/*.sql to the database in SUPABASE_DB_URL.
 *
 *   node --env-file=.env scripts/db.mjs          # show what would run
 *   node --env-file=.env scripts/db.mjs --apply  # actually run it
 *
 * Each file runs inside its own transaction, so a migration that fails
 * halfway leaves nothing behind.
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

for (const file of files) {
  const sql = await readFile(path.join(MIGRATIONS, file), 'utf8')
  const sha = createHash('sha256').update(sql).digest('hex')
  console.log(`${file}`)
  console.log(`  sha256 ${sha}`)

  if (!apply) {
    console.log('  (dry run — pass --apply to execute)\n')
    continue
  }

  try {
    await client.query('begin')
    await client.query(sql)
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

await client.end()
