/**
 * Turning the database's answer into an HTTP response a person can read.
 *
 * This layer decides nothing. Nothing here runs unless the database has
 * already refused, and every branch is keyed on what it said — a constraint
 * name or a message the schema raised. It rephrases; it never judges.
 *
 * The raw message always survives as `detail`, so a rule that fires
 * unexpectedly stays diagnosable instead of being hidden behind friendly
 * prose. If you find yourself wanting to add a case that fires *before* the
 * database has spoken, that belongs in the schema, not here.
 */

export type PgLikeError = {
  code?: string | null
  message?: string | null
  details?: string | null
}

/** Postgres SQLSTATEs the schema can raise, and what they mean over HTTP. */
const STATUS_BY_SQLSTATE: Record<string, number> = {
  '23514': 422, // check_violation — rules 1, 2 and 4, and the update guard
  '23505': 409, // unique_violation — one_live_claim_per_number
  '23503': 422, // foreign_key_violation — no player row
  '23502': 422, // not_null_violation
  '42501': 403, // insufficient_privilege — self-review, undo by the wrong person
  '22P02': 422, // invalid_text_representation
}

/** PostgREST's own codes, which are not SQLSTATEs. */
const STATUS_BY_POSTGREST: Record<string, number> = {
  PGRST116: 404, // no rows returned where one was required
  PGRST205: 500, // table missing from the schema cache — migration not applied
}

export function statusForDbError(error: PgLikeError | null | undefined): number {
  const code = error?.code ?? ''
  return STATUS_BY_SQLSTATE[code] ?? STATUS_BY_POSTGREST[code] ?? 500
}

/**
 * Extra facts a caller can supply so a message can be specific. These are read
 * from the database too — `nextTarget` comes from v_player_state, never from a
 * calculation here.
 */
export type ErrorContext = {
  plate?: string
  claimedNumber?: number
  nextTarget?: number | null
}

const pad = (n: number) => n.toString().padStart(3, '0')

/**
 * The database's message, said in plain words. Returns null when we have no
 * better phrasing than what the database already said.
 */
function rephrase(raw: string, ctx: ErrorContext): string | null {
  // Rule 1 — format. Two separate constraints, two separate mistakes.
  if (raw.includes('claims_plate_check')) {
    return `A California plate looks like 1ABC234 — one digit, three letters, then three digits.${
      ctx.plate ? ` "${ctx.plate}" doesn't.` : ''
    }`
  }
  if (raw.includes('number_matches_plate')) {
    return "The last three digits of the plate are the number you're claiming, and those don't match."
  }

  // Rule 2 — target.
  if (raw.startsWith('rule 2:')) {
    if (ctx.nextTarget != null && ctx.claimedNumber != null) {
      return `The plate claims ${pad(ctx.claimedNumber)}, but you're on ${pad(ctx.nextTarget)}.`
    }
    if (ctx.nextTarget != null) return `You're on ${pad(ctx.nextTarget)} next.`
    return 'That plate is not the number you are up to.'
  }

  // Rule 4 — capture order.
  if (raw.startsWith('rule 4:')) {
    return 'That photo was taken before your previous plate.'
  }

  // One live claim per number.
  if (raw.includes('one_live_claim_per_number')) {
    return 'You already have a live claim on that number.'
  }

  // The update guard and review rules.
  if (raw.includes('a player cannot review their own claim')) {
    return 'You cannot review your own claim.'
  }
  if (raw.includes('finality window')) {
    return 'This claim is too old to reject now. It can still be approved.'
  }
  if (raw.includes('claim evidence is immutable')) {
    return 'A claim cannot be edited once submitted.'
  }
  if (raw.includes('only the original rejector or an admin')) {
    return 'Only the person who rejected this, or an admin, can undo it.'
  }

  return null
}

/**
 * A JSON body for a failed request.
 *
 * `error` is what the UI shows. `detail` is what the database actually said,
 * kept so an unexpected rule is still traceable.
 */
export function dbErrorBody(error: PgLikeError | null | undefined, ctx: ErrorContext = {}) {
  const raw = error?.message ?? 'unknown database error'
  return {
    error: rephrase(raw, ctx) ?? raw,
    detail: raw,
    code: error?.code ?? null,
  }
}
