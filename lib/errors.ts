/**
 * Turning the database's answer into an HTTP response.
 *
 * The routes do not decide what is valid — constraints, triggers and policies
 * do. This maps what Postgres said into a status code, and passes its message
 * through rather than inventing a friendlier one, because the database's
 * message names the actual rule that fired ("rule 2: next target is 70, not
 * 72") and a rewritten one drifts from it.
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
 * A JSON body for a failed request. `rule` carries the database's message
 * verbatim so the UI can show which rule refused, rather than a generic
 * "invalid submission".
 */
export function dbErrorBody(error: PgLikeError | null | undefined) {
  return {
    error: error?.message ?? 'unknown database error',
    code: error?.code ?? null,
  }
}
