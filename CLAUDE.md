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
- **No auto-approval.** Every claim waits for a human. Unreviewed claims stay pending indefinitely; this doesn't stall play, because pending claims still count toward advancing your target.
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

---

## How to work on this project

- **Suggest first.** Propose the change, answer any questions, summarize what was agreed, and write code only after approval. This applies to schema changes especially.
- **Ask rather than assume.** If a requirement is ambiguous, ask — don't pick a reading and build on it silently.
- **Changelogs are concise and bulleted.**
- Flag design consequences that weren't asked about. A rule with an expensive side effect is worth a sentence before it's implemented, not after.

---

@AGENTS.md
