# Plate Chase

A leaderboard, progress chart, and map for a California license-plate sequence game played by three friends.

Full submit-path design: `docs/design/submit-path.md`. Read it before touching the schema or the claim flow.

---

## The game

Find California plates in sequential order by their last three digits, 000 through 999. Players photograph plates in the wild and claim them. A plate counts only if it matches `^[0-9][A-Z]{3}[0-9]{3}$`.

### The five rules

1. **Format** — the regex above, and it must be a California plate.
2. **Target** — the last three digits are the plate's number. Your next target is one more than your highest valid plate.
3. **Evidence** — a photo of a plate on a real vehicle.
4. **Order** — the photo for target *N* must have been **captured** after the photo for *N−1*. Captured, not uploaded.
5. **Finality** — a rejected claim voids everything found after it.

### Who enforces what

| Rule | Enforced by |
|---|---|
| 1 — format regex | Database |
| 1 — is actually California | Human reviewer |
| 2 — correct target | Database |
| 3 — real plate on a real vehicle | Human reviewer |
| 3 — photo matches the claimed number | Human reviewer |
| 4 — capture ordering | Database (when capture time is present) |
| 5 — cascade | Derived at read time |

A claim that fails a database check never reaches review. The reviewer only answers the three questions a machine can't.

---

## Stack

| Piece | Role |
|---|---|
| Next.js (App Router) | The app |
| Vercel | Hosting |
| Supabase | Postgres + Auth; all metadata and all rules |
| Cloudflare R2 | Photo files |

---

## Settled decisions

Do not relitigate these without asking. They were argued through and written down.

- **Three statuses only** — `pending`, `approved`, `rejected`. Status records the reviewer's verdict on that claim alone. Nothing else.
- **Derive, don't mutate.** Rule 5's cascade is a query, not a trigger. A player's streak is their approved claims up to their first rejection, computed at read time. This is why undo is cheap and why there's no cascade to get half-run.
- **`seed_next`** — each player's pre-launch position, stored as the number they were *hunting* at launch (69, 104, 112). Players had already validated each other's history; the app trusts that baseline rather than backfilling hundreds of photo-less rows.
- **Auto-approval is derived, never stored.** A claim nobody objected to before the finality window closed counts, and is labelled `auto_approved` — because past that window it cannot be rejected, so asking for an approving click asks for a formality. `status` still has three values and still records a human's verdict; an auto-approved claim is `pending` with `reviewed_by` null, which is the honest record. No job, no SYSTEM actor. Superseded the original "no auto-approval" rule on 2026-08-31; see `submit-path.md` §8.
- **Rejection undo** — exposed in the UI, restricted to the original rejector or an admin, allowed at any time including past the finality window. Undo only ever restores; the window exists to stop retroactive destruction.
- **Uploads go browser → R2 directly** via presigned URL, never proxied through Next.js. Vercel caps serverless request bodies around 4.5 MB and phone photos exceed it.
- **EXIF is read server-side** from the uploaded original. Never resize client-side — it strips the capture time that rule 4 depends on.

---

## Conventions

- Business rules live in Postgres, not TypeScript. See the `db-rules` skill.
- Migrations are forward-only and live in `supabase/migrations/`. Never edit one that has been applied.
- Every table has RLS enabled.
- Every rule gets a test, including a negative case proving the constraint actually fires.
- Design docs live in `docs/design/`. When a rule changes, the doc and its tests change in the same commit.
- Prefer commenting out a superseded column over dropping it in the same migration; drop it later once nothing references it.
- **The UI does not know the rules.** Never re-implement one client-side for faster feedback — two copies become two rules, and the one users see is the wrong one. If the UI needs to know whether something is valid, ask the database.
- **Derived values come from one place.** Streak, next target, counts: defined once as a view or function, read from there, never recomputed in a component.
- **UI changes must not move the layout.** See the `ui-stability` skill.

---

## How to work on this project

- **Fix the cause.** Trace a failure to the decision that allowed it and fix that. A workaround that leaves the cause in place is debt — say so plainly and call it debt, rather than describing it as a fix.
- **Don't build machinery around a state that shouldn't exist.** If fixing the cause makes a condition impossible, delete the handling for it. Adding an escape hatch, then a message, then space reserved for the message, is three pieces of code standing in for one deletion.
- **Comments are concise and direct.** What the code does, and why a non-obvious choice was made. Not the history of how it came to be that way — that is what commits are for.
- **Suggest first.** Propose the change, answer any questions, summarize what was agreed, and write code only after approval. This applies to schema changes especially.
- **Ask rather than assume.** If a requirement is ambiguous, ask — don't pick a reading and build on it silently.
- **Changelogs are concise and bulleted.**
- Flag design consequences that weren't asked about. A rule with an expensive side effect is worth a sentence before it's implemented, not after.
- **Work happens on a branch, never on `main` directly** — including one-line copy changes. Small edits are exactly what stacked 47 commits the first time; "too small to branch" is how it happens. Commit freely on the branch, then squash-merge one commit per unit of work when it is agreed. `main` is a list of features, not of keystrokes.
- **A new feature starts with the `requirements` skill**, before any implementation code. The doc it produces is what QA verifies against.
- **A feature is not done until `qa-verifier` has run against it.** It reads the design doc in a fresh context and checks each requirement against what was actually built. The author checking their own work is the gap it exists to close.

---

@AGENTS.md
