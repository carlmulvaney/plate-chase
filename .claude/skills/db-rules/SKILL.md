---
name: db-rules
description: Use when writing or changing Postgres schema, constraints, triggers, RLS policies, views, or Supabase migrations. Covers where business rules belong, migration discipline, and how rules get tested.
---

# Database rules

Business rules live in Postgres. The application layer reports what the database decided; it does not decide.

## The enforcement ladder

Prefer the earliest option that actually works:

1. **Check constraint** — for anything expressible about a single row.
2. **Generated column** — for a value derivable from other columns in the same row.
3. **Unique or partial index** — for "only one of these can exist" rules.
4. **Trigger** — when the rule needs to look at other rows.
5. **RLS policy** — for who may do what.
6. **Application code** — last resort.

If a rule ends up in application code, say why in a comment and in the PR. That is a real decision, not a default.

## Derive, don't store

If a value is computable from other rows, compute it — in a view or a function. Do not store it and keep it in sync.

Stored state that duplicates derivable state drifts, and the drift is silent. The reference case here is rule 5: a rejection does not rewrite the claims after it. A player's streak is derived at read time as their approved claims up to their first rejection. That is why undoing a rejection is a single-row update with no repair logic, and why there is no cascade that can half-run.

Before adding a column, ask whether it's a fact or a conclusion. Facts get stored. Conclusions get derived.

## Row-level security

RLS is enabled on every table. No exceptions, including tables that "aren't sensitive" — an un-policied table is a hole that gets found later.

Policies are the permission model. The app never enforces access on its own; if the UI hides a button, that is a courtesy, not a control.

The service role key is server-side only. It must never reach the browser, and it must never be used to work around a policy that's inconvenient — fix the policy.

## Migrations

- Live in `supabase/migrations/`, timestamped, forward-only.
- **Never edit a migration that has been applied.** Add a new one.
- One logical change per migration. A migration that does three unrelated things cannot be reasoned about when it fails halfway.
- Prefer commenting out a superseded column to dropping it in the same migration. Drop it in a later migration once nothing references it.
- Destructive operations get called out explicitly before they're written, not discovered in review.

## Testing

Every rule gets a test, and every test includes a **negative case** that proves the constraint actually fires. A constraint with only a happy-path test is untested — it would pass just as well if it didn't exist.

Test the rule at the layer that owns it. If the design doc says the database enforces something, the test must show the database rejecting it, not the API returning a 400.

## Naming

- Tables plural, columns `snake_case`.
- Constraints named for what they assert (`number_matches_plate`), not for the table they're on.
- A trigger's name says when it fires and what it checks.
