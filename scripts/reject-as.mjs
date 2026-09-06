/**
 * Reject one claim on behalf of a fixture player, for testing rejection states.
 *
 *   node --env-file=.env scripts/reject-as.mjs --submitter carlmulv --number 3 --by Rex
 *   node --env-file=.env scripts/reject-as.mjs ... --project <ref> --confirm
 *
 * DEBT, not a feature. Fixture players sit in auth.users with @plate-chase.test
 * addresses and no mailbox, and sign-in is email-only — so nobody can act as
 * them in the app, and rejection states are unreachable through the UI. The
 * cause is that there is no way to hold a session as a fixture account; the
 * fix is an /auth/confirm route plus a link minted by auth.admin.generateLink,
 * after which this script has no reason to exist. Until then a whole class of
 * screens can only be set up from outside the app.
 *
 * Undo with: scripts/reset-claims.mjs --reopen
 */

import pg from 'pg'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  const v = i === -1 ? undefined : args[i + 1]
  return v && !v.startsWith('--') ? v : undefined
}

const submitter = flag('submitter')
const number = flag('number')
const by = flag('by')
const confirm = args.includes('--confirm')
const wanted = flag('project')

if (!submitter || number === undefined || !by) {
  console.error('usage: --submitter <name> --number <n> --by <name> [--project <ref> --confirm]')
  process.exit(1)
}

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error('SUPABASE_DB_URL is not set — run with: node --env-file=.env ...')
  process.exit(1)
}

// The pooler username is postgres.<project-ref>: the project this string
// genuinely reaches, whatever anyone believes it points at.
const parsed = new URL(url.replace(/^postgresql:/, 'http:'))
const actual = decodeURIComponent(parsed.username).split('.')[1] ?? '(unknown)'
console.log(`project: ${actual}\n`)

if (confirm && wanted !== actual) {
  console.error(
    wanted
      ? `refusing: --project ${wanted} does not match ${actual}, which is what this connection string reaches`
      : `refusing: --confirm requires --project ${actual}, so the target is stated rather than assumed`,
  )
  process.exit(1)
}

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await db.connect()

const one = async (sql, params) => (await db.query(sql, params)).rows[0]

const claim = await one(
  `select c.id, c.number, c.plate, c.status
     from claims c join players p on p.id = c.player_id
    where p.display_name = $1 and c.number = $2 and c.status <> 'rejected'`,
  [submitter, Number(number)],
)
const reviewer = await one('select id, display_name from players where display_name = $1', [by])

if (!claim) {
  console.error(`no unrejected claim ${number} for ${submitter}`)
  process.exit(1)
}
if (!reviewer) {
  console.error(`no player named ${by}`)
  process.exit(1)
}
if (claim.status === 'approved') {
  console.error(`${submitter} ${claim.number} is approved; the guard refuses approved -> rejected`)
  process.exit(1)
}

// What the rejection costs, read from the same function the app reads.
const { rows: stranded } = await db.query(
  `select number, plate from claims
    where player_id = (select id from players where display_name = $1)
      and number > $2 and status <> 'rejected' order by number`,
  [submitter, claim.number],
)

const label = `${submitter} ${String(claim.number).padStart(3, '0')} ${claim.plate}`
console.log(`reject ${label}  as ${reviewer.display_name}`)
console.log(`strands ${stranded.length} claim(s) above it:`)
for (const s of stranded) console.log(`   ${String(s.number).padStart(3, '0')}  ${s.plate}`)

if (!confirm) {
  console.log(`\nDry run. To do it:`)
  console.log(
    `  node --env-file=.env scripts/reject-as.mjs --submitter ${submitter} --number ${number} --by ${by} --project ${actual} --confirm`,
  )
  await db.end()
  process.exit(0)
}

// Both triggers stand aside: the guard because a verdict needs a signed-in
// reviewer and there is none over a direct connection, and the log because it
// takes actor_id from that same absent auth.uid(). The log row is then written
// by hand, so the audit trail says who did it rather than nothing.
await db.query('alter table claims disable trigger trg_claims_before_update_guard')
await db.query('alter table claims disable trigger trg_claims_after_status_change_log')
try {
  await db.query(
    `update claims set status = 'rejected', reviewed_by = $1, reviewed_at = now() where id = $2`,
    [reviewer.id, claim.id],
  )
  await db.query(
    `insert into claim_review_events (claim_id, actor_id, action, note)
     values ($1, $2, 'reject', 'scripted')`,
    [claim.id, reviewer.id],
  )
} finally {
  await db.query('alter table claims enable trigger trg_claims_before_update_guard')
  await db.query('alter table claims enable trigger trg_claims_after_status_change_log')
}

const state = await one(
  `select next_target, first_rejected, confirmed_count, pending_count
     from v_player_state where display_name = $1`,
  [submitter],
)
const { rows: blocked } = await db.query(
  `select b.number, b.plate from v_blocked_claims b join players p on p.id = b.player_id
    where p.display_name = $1 order by b.number`,
  [submitter],
)

console.log(`\nrejected. ${submitter} is now:`)
console.log(
  `  target ${String(state.next_target).padStart(3, '0')} · first_rejected ${state.first_rejected} · confirmed ${state.confirmed_count} · pending ${state.pending_count}`,
)
console.log(`  blocked: ${blocked.map((b) => `${String(b.number).padStart(3, '0')} ${b.plate}`).join(', ') || 'none'}`)

await db.end()
