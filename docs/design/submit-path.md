# Plate Chase — Submit Path Design

Design for the claim submission and review flow. Written before implementation.

---

## 1. Stack

| Piece | What it is | What it holds |
|---|---|---|
| **Next.js** | JavaScript web framework — pages, routing, and server-side code in one project | The app itself |
| **Vercel** | Hosting for Next.js; deploys on push to GitHub | Where the app runs |
| **Supabase** | Hosted Postgres, plus user accounts/login (Auth) | All metadata, all rules |
| **Cloudflare R2** | Object storage | The photo files themselves |

Rules live in Postgres — as constraints, triggers, and row-level security policies — not in application code. The Next.js layer stays thin.

---

## 2. The five rules

1. **Format** — plate matches `^[0-9][A-Z]{3}[0-9]{3}$` and is a California plate.
2. **Target** — the plate's last three digits are its number; your next target is one more than your highest valid plate.
3. **Evidence** — a photo of a plate on a real vehicle.
4. **Order** — the photo for *N* must have been *captured* after the photo for *N−1*.
5. **Finality** — a rejected claim voids everything found after it.

### Who enforces what

| Rule | Enforced by | Notes |
|---|---|---|
| 1 — format | **Database** | Regex check constraint |
| 1 — is California | **Human** | Not derivable from the number |
| 2 — correct target | **Database** | Must count pending claims, not just approved |
| 3 — real plate, real vehicle | **Human** | |
| 3 — photo matches claim | **Human** | Nothing machine-side sees the image |
| 4 — capture order | **Database** | When capture time is present |
| 5 — cascade | **Derived** | See §6 — not a stored mutation |

A claim that fails any database check is rejected at submit time and never reaches review. The reviewer only ever answers the three human questions.

---

## 3. Submit flow

The photo and its metadata live in different stores, so submission is a four-step handshake designed so neither can exist without the other.

1. **Request an upload slot.** Client sends the claimed plate. Server validates format and target, creates a `claims` row with `uploaded_at = null`, generates an R2 object key, returns the key plus a presigned PUT URL.
2. **Client uploads the original file directly to R2** using the presigned URL.
3. **Client confirms completion** to the server with the claim id.
4. **Server fetches the object back from R2**, reads EXIF, writes `captured_at` and GPS to the row, runs the rule-4 ordering check, and sets `uploaded_at`.

### Why this shape

- **Direct-to-R2, not proxied through Next.js.** Vercel caps serverless request bodies around 4.5 MB; phone photos routinely exceed that.
- **EXIF is read server-side**, from the uploaded original — one code path, immune to mobile browser quirks, and re-derivable later if a claim is ever disputed.
- **Upload the original file, never a client-resized copy.** Any in-browser resize strips EXIF and destroys the rule 4 evidence. Display derivatives are generated server-side.
- **HEIC**: iPhones shoot HEIC by default and browsers can't render it. Transcode for display, keep the original as evidence of record.
- **The row exists before the upload**, which gives orphan cleanup a handle: any claim with `uploaded_at IS NULL` older than an hour — delete the object and the row.

---

## 4. Data model

```sql
create table players (
  id           uuid primary key references auth.users(id),
  display_name text not null,
  seed_next    int  not null default 0,    -- the number they were hunting at launch
  is_admin     boolean not null default false
);

create type claim_status as enum ('pending', 'approved', 'rejected');

create table claims (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references players(id),
  number       int  not null check (number between 0 and 999),
  plate        text not null check (plate ~ '^[0-9][A-Z]{3}[0-9]{3}$'),
  photo_key    text not null,
  uploaded_at  timestamptz,               -- null until R2 upload is confirmed
  captured_at  timestamptz,               -- from EXIF; null if absent
  gps_lat      numeric,
  gps_lon      numeric,
  status       claim_status not null default 'pending',
  reviewed_by  uuid references players(id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),

  -- the claimed number must be the plate's own last three digits
  constraint number_matches_plate check (number = right(plate, 3)::int),
  -- a reviewer cannot be the submitter
  constraint no_self_review check (reviewed_by is null or reviewed_by <> player_id)
);

-- at most one live claim per player per number
create unique index one_live_claim_per_number
  on claims (player_id, number)
  where status <> 'rejected';

-- append-only log of review actions; see §7
create table claim_review_events (
  id         uuid primary key default gen_random_uuid(),
  claim_id   uuid not null references claims(id),
  actor_id   uuid not null references players(id),
  action     text not null check (action in ('approve', 'reject', 'undo_reject')),
  note       text,
  created_at timestamptz not null default now()
);

create table app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references players(id)
);
-- seed: ('finality_days', '14')
```

`seed_next` carries the pre-launch history. Players had already validated each other's finds before the app existed, so the app trusts that baseline rather than re-verifying hundreds of photos nobody kept. It stores the number a player was *hunting* at launch — the same way players describe their own position — so the launch values go in verbatim:

| Player | `seed_next` | Plates found |
|---|---|---|
| 1 | 69 | 69 (000–068) |
| 2 | 104 | 104 (000–103) |
| 3 | 112 | 112 (000–111) |

It does three jobs: sets the opening target, tells rule 4 that a player's first in-app claim legitimately has no predecessor photo, and anchors the leaderboard count.

The alternative — inserting synthetic approved rows for every plate already found — would mean hundreds of photo-less records polluting the map and the chart. One integer is cleaner.

---

## 5. Database checks at submit

**Rule 2 — correct target.** Reject unless `number = next_target(player)` (§6).

**Rule 4 — capture ordering.** Find the predecessor: the player's claim at `number - 1` with status `pending` or `approved`.

- No predecessor (i.e. `number <= seed_next`, so the previous plate predates the app) → passes vacuously.
- Predecessor exists, both timestamps present → require `new.captured_at > predecessor.captured_at`.
- Either timestamp missing → **pass**, and the claim goes to review for a human to judge.

Missing capture time is not a rejection. It's a question a person answers.

---

## 6. Rule 5 as a derived value

Nothing is rewritten when a rejection lands. A claim's `status` records only the reviewer's verdict on that claim's own merits. Whether it *counts* is computed.

```
first_rejected := min(number) where player = P and status = 'rejected'

active := claims where player = P
            and status in ('pending', 'approved')
            and (first_rejected is null or number < first_rejected)

next_target := greatest(seed_next, coalesce(max(active.number) + 1, seed_next))

confirmed_count := seed_next
                 + count(claims where player = P
                           and status = 'approved'
                           and (first_rejected is null or number < first_rejected))
```

### Why derive rather than cascade

- **No cascade trigger**, so no failure mode where the cascade half-ran and left the data inconsistent.
- **Undo is free.** Reversing a mistaken rejection is flipping one row back to `pending`; the streak recomputes itself. This matters — one approval is enough to reject, and a rejection at plate 40 costs someone 70 finds. That much destructive power needs a cheap undo.
- **Three statuses stay three**, and they mean exactly one thing: the reviewer's verdict. Consequence is a separate concern.

Pending claims sitting *above* a rejection are orphaned — they neither count nor block. Surface them in the UI as blocked rather than awaiting review.

---

## 7. Review flow

A claim is reviewable when it is `pending`, `uploaded_at` is set, and the reviewer is not the submitter. One approval settles it.

The review screen shows the photo, the claimed plate, and — importantly — **the capture time and how it compares to the previous claim's**. Rule 4 is currently enforced on a value no human ever sees; if the reviewer can't see it, they can't catch the case where it's wrong but well-formed.

The reviewer answers three questions, because the database already guaranteed everything else:

1. Is this a California plate?
2. Is it on a real vehicle?
3. Does the plate in the photo match the claim?

Past the finality window a claim can no longer be **rejected**. It can still be approved, at any age.

That asymmetry is the point, and it was got wrong once. Bounding *every* verdict by the window made two promises hollow:

- Undo is unbounded (below) so that a mistake found on day 15 is recoverable. But restoring a day-30 rejection put the claim back to `pending` where nobody was allowed to approve it — the row came back and the find did not. The window had been lifted from the undo and left on the re-judgement that undo exists to reopen.
- With no auto-approval (§8), a claim nobody happened to look at for fourteen days could never count at all.

Approval takes nothing from anyone, so nothing needs protecting from it. Only destruction is bounded.

`finality_days` is read from `app_config` so admin can change it without a deploy.

### What the reviewer answers

The three questions §2 assigns to a human — is it a California plate, is it on a real vehicle, does the plate match the claim — are not printed on the screen. They are the reviewer's whole job and the screen exists to show the evidence for them; listing them pushed the photo away from the buttons without telling anyone anything. The database has already refused everything it can, so whatever reaches this screen is there for exactly those three judgements.

### Rejection undo

A rejection is one person's click and it costs the submitter their whole streak from that point, so it has to be reversible.

- **Who** — the original rejector (`reviewed_by = auth.uid()`) or an admin. Enforced by RLS, not by hiding the button.
- **What it does** — sets `status` back to `pending` and clears `reviewed_by` / `reviewed_at`. The claim rejoins the review queue and can be judged again by anyone eligible.
- **When** — at any time, including past the finality window. The window exists to stop retroactive *destruction*; undo only ever restores. Bounding it would mean a mistake discovered on day 15 is permanent, which is the opposite of what the rule is for.

Because §6 derives the streak rather than storing it, undo needs no repair logic — flipping the one row recomputes everyone's position.

### Review history

Undo means a claim's status is no longer a complete account of what happened to it: `pending → rejected → pending → approved` collapses to a single word, and after an undo there is no trace the rejection ever occurred. Given a rejection temporarily wipes someone's streak, the other players will want to see that.

`claim_review_events` (§4) is an append-only log of every approve, reject, and undo. Small table, no maintenance, and it gives the UI something honest to show: *"Dave rejected this on the 3rd, undid it on the 4th."* The claim row keeps the current verdict; the log keeps the story.

### No auto-approval

Every claim waits for a human. A claim nobody reviews stays `pending` indefinitely.

This does not stall the game: §6 counts pending claims in `active`, so a player keeps advancing to their next target while earlier claims sit unreviewed. The only thing pending claims don't do is contribute to `confirmed_count` on the leaderboard.

Deferred rather than rejected — see §8.

---

## 8. Open questions

1. **Auto-approval** — ~~deferred~~ **adopted, 2026-08-31**, in the shape this section predicted: a derived `effective_status`, not a job.

   The reason turned out not to be review backlog. Once the finality window was corrected to bound rejection only (§7), a past-window claim had exactly two possible fates: someone clicks approve, or nobody does and it never counts. That click expresses no judgement, because the judgement it would express — rejection — is no longer available. Withholding the find until someone performs the formality is an arbitrary penalty for nobody having looked in time.

   `effective_status(status, created_at)` returns `pending`, `approved`, `auto_approved` or `rejected`. `auto_approved` means `status = 'pending'` and the window has closed. Nothing is written: the claim is still pending, `reviewed_by` is still null, and there is no SYSTEM actor, because no actor acted. `claim_review_events` records review actions and this is the absence of one.

   Downstream: `confirmed_count` counts it, `pending_count` does not, and it leaves `v_review_queue` — a queue is for things that need deciding. `v_auto_approved` lists them, and the submit screen shows a player their own, so the distinction between "verified" and "unobjected" is visible rather than silent.

   Two consequences, both accepted:
   - A confirmed count can rise overnight with no request and no write.
   - `finality_days` is retroactive. Lower it and claims flip to auto-approved at once; raise it and they revert, and counts fall. That is the cost of it being reversible instead of stamped into rows.
2. **Plate OCR** — deferred, not rejected. Reading the plate from the photo and comparing it to the claim would close the largest remaining gap: nothing machine-side verifies the image matches the number. Worth revisiting once the manual flow works.

---

## 9. Not in scope

Leaderboard, progress chart, and map are all read-side and depend only on `claims` plus the derived values in §6. They come after the submit and review paths work.

**A claims table** belongs with them: every claim in one place, filterable by status and by player, sortable by the dates. It replaces two things built earlier as stopgaps — the "Counted unobjected" section on the submit screen and, probably, the rejections list on the review screen — because both are a filter on that table with the filter hard-coded. The unobjected section carries a comment saying so; it should be deleted when the table lands, not maintained alongside it.

GPS is deliberately excluded from that table. The coordinates exist for the map, and a pin on a map is a different thing from a sortable column of where everyone was standing.
