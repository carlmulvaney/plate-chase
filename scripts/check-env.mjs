/**
 * Verify every credential in .env actually works, before code depends on it.
 *
 *   node --env-file=.env scripts/check-env.mjs
 *
 * Checks the Supabase REST API, the direct Postgres connection, and both R2
 * buckets. Prints no secret values — only whether each one works.
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import pg from 'pg'

const results = []
const record = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

const need = (name) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is empty in .env`)
  return v
}

// --- Supabase REST -------------------------------------------------------
try {
  const url = need('NEXT_PUBLIC_SUPABASE_URL')
  const key = need('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  // Not `/rest/v1/` — that root serves the OpenAPI spec and accepts secret
  // keys only, so a publishable key gets a 401 there no matter how valid it
  // is. Ask for a table instead: 401 is the only answer that means the key
  // was refused. A 404 just means the migration is not applied yet.
  const res = await fetch(`${url}/rest/v1/players?select=id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  record('supabase rest api (publishable key)', res.status !== 401,
    res.status === 401 ? 'rejected the key' : `HTTP ${res.status}`)
} catch (e) {
  record('supabase rest api (publishable key)', false, e.message)
}

// --- Supabase, service role ---------------------------------------------
try {
  const url = need('NEXT_PUBLIC_SUPABASE_URL')
  const key = need('SUPABASE_SERVICE_ROLE_KEY')
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  record('supabase rest api (service role key)', res.status !== 401,
    res.status === 401 ? 'rejected the key' : `HTTP ${res.status}`)
} catch (e) {
  record('supabase rest api (service role key)', false, e.message)
}

// --- Direct Postgres -----------------------------------------------------
{
  const client = new pg.Client({
    connectionString: need('SUPABASE_DB_URL'),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })
  try {
    await client.connect()
    const { rows: [v] } = await client.query('select version() as v')
    record('postgres connection', true, v.v.split(',')[0])

    const { rows: [t] } = await client.query(`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'public'
         and table_name in ('players','claims','claim_review_events','app_config')
    `)
    record('migration applied to this project', t.n === 4,
      t.n === 4 ? 'all four tables present' : `${t.n}/4 tables — not applied yet`)
  } catch (e) {
    record('postgres connection', false, e.message)
  } finally {
    await client.end().catch(() => {})
  }
}

// --- Cloudflare R2 -------------------------------------------------------
try {
  const account = need('R2_ACCOUNT_ID')
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: need('R2_ACCESS_KEY_ID'),
      secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
    },
  })

  for (const name of ['R2_BUCKET_ORIGINALS', 'R2_BUCKET_DISPLAY']) {
    const bucket = need(name)
    try {
      // MaxKeys 1 keeps this cheap — the question is whether the credentials
      // can read the bucket, not how much is in it. Deliberately no object
      // count: KeyCount here is capped at 1, so reporting it reads as "the
      // bucket has one object" and would look like data had disappeared.
      await r2.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }))
      record(`r2 bucket ${bucket}`, true, 'readable')
    } catch (e) {
      record(`r2 bucket ${bucket}`, false, `${e.name}: ${e.message}`)
    }
  }
} catch (e) {
  record('r2', false, e.message)
}

// --- Summary -------------------------------------------------------------
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
