# Plate Chase — Bulk Upload Design

Submitting several claims in one go. Written before implementation.

Not to be confused with the pre-launch history, which is handled by `seed_next`
(see `submit-path.md` §4) and involves no photos at all.

---

## 1. Why

Players find plates in bursts — an afternoon out produces three or four before
anyone sits down at a phone. Claiming them one at a time means repeating the
whole handshake by hand, and the ordering rule makes mistakes easy: get the
sequence wrong and the fourth claim is refused for a reason that is not the
player's fault.

---

## 2. What a batch is

The app cannot tell which plate is in which photo — plate OCR is deferred
(`submit-path.md` §8) and nothing machine-side reads the image. So a batch is
an **ordered list of (plate, photo) pairs**, with the plate typed by the player,
not a pile of photos.

The order is not cosmetic. Rule 2 makes the targets consecutive, so position 1
claims the next target, position 2 the one after, and so on. Rule 4 then
requires each photo to have been captured after the one before it.

---

## 3. Requirements

### B1 — A batch is an ordered list of plate-and-photo pairs
Every photo in a batch carries a plate the player typed for it.
**Owner:** ui

| # | Case | Expect |
|---|---|---|
| B1.1 | Four photos chosen, four plates typed | Batch is submittable |
| B1.2 | Four photos chosen, one plate left blank | Batch is not submittable; the incomplete row is marked |

### B2 — Each pair claims the next target, in order
Position *n* in the batch claims the target after position *n−1*.
**Owner:** database — the existing rule-2 trigger, unchanged

| # | Case | Expect |
|---|---|---|
| B2.1 | Target is 002; batch of three claims 002, 003, 004 | All three accepted |
| B2.2 | Target is 002; the second pair's plate ends in 007 | Second claim refused, batch stops (B5) |

### B3 — The batch defaults to capture-time order, oldest first
When photos carry capture times, the rows are arranged oldest first before
anything is submitted.
**Owner:** ui — presentation only

Read in the browser purely to order the list. It is **not** the value rule 4 is
enforced on: the server reads EXIF from the uploaded original as it always has,
and the database decides. A browser that reports nothing, or something wrong,
can therefore produce a badly ordered list but can never produce a wrong
verdict.

| # | Case | Expect |
|---|---|---|
| B3.1 | Three photos added in the order Wed, Mon, Tue | Rows arrange Mon, Tue, Wed |
| B3.2 | Browser cannot read capture times at all | Rows keep the order the files were added; batch still submittable |

### B3a — Photos with no capture time keep their position
A photo whose capture time is absent is not sorted; it stays where the player
put it, after any photos that do have times.
**Owner:** ui

| # | Case | Expect |
|---|---|---|
| B3a.1 | Two photos with times, one without | The two sort by time; the third follows them |
| B3a.2 | No photo has a capture time | Order is exactly as added |

### B4 — The player can reorder the batch
Rows can be dragged into any order, and that order is what gets submitted.
**Owner:** ui

| # | Case | Expect |
|---|---|---|
| B4.1 | Player drags row 3 to position 1 | Submission claims that photo's plate first |
| B4.2 | Player reorders after the automatic sort | The player's arrangement wins; no re-sort happens |

### B5 — A failure stops the batch, and everything before it stands
Pairs are processed in order. The first one the database refuses ends the
batch. Claims already made are kept.
**Owner:** ui/app — orchestration; each individual verdict is the database's

| # | Case | Expect |
|---|---|---|
| B5.1 | Batch of four, third has a malformed plate | First two claimed; third reported with the database's reason; fourth not attempted |
| B5.2 | Batch of four, third breaks capture order | First two claimed; third refused by rule 4; fourth not attempted |
| B5.3 | Batch of four, all valid | All four claimed |

### B6 — Nothing after a failure is created
No row and no object exists for any pair at or after the failure.
**Owner:** app

This is the requirement that prevents a gap. Rule 2 is checked only at insert,
so if 004 and 005 were created before 003 failed and was deleted, 003 would be
permanently unclaimable and `next_target` would sit at 006. Creating rows
strictly one at a time, each only after the previous has been confirmed, is
what makes that state unreachable.

| # | Case | Expect |
|---|---|---|
| B6.1 | Third of four fails | `claims` contains exactly the first two; no row for the third, fourth |
| B6.2 | Third of four fails | Neither bucket holds an object for the third or fourth |
| B6.3 | After a stopped batch | `next_target` is the failed pair's number, not a number beyond it |

### B7 — A refused pair leaves nothing behind
A pair the database refuses leaves no claim row and no photo in R2.
**Owner:** app — the existing rule-4 cleanup in `/api/submit/commit`

| # | Case | Expect |
|---|---|---|
| B7.1 | A pair fails rule 4 after its photo uploaded | Row deleted, original deleted from R2 |
| B7.2 | A pair fails rule 2 before any upload | No row created; nothing to clean up |

### B8 — The player is told what happened to each pair
The result names every pair and its outcome, and gives the database's reason
for the one that stopped the batch.
**Owner:** ui

| # | Case | Expect |
|---|---|---|
| B8.1 | Two of four succeed | Both are listed as claimed, with their numbers |
| B8.2 | Third fails rule 2 | Its row shows "The plate claims 007, but you're on 003." |
| B8.3 | Fourth never attempted | Shown as not attempted, not as failed |

### B9 — A single claim is a batch of one
There is one form and one code path; submitting one photo is the same
operation with a shorter list.
**Owner:** ui

| # | Case | Expect |
|---|---|---|
| B9.1 | One photo, one plate | Claimed, same as the current form |
| B9.2 | One photo that fails rule 4 | Same message as today, row and object removed |

---

## 4. Flow

Strictly serial, one pair at a time:

```
for each pair, in the batch's order:
    init   → create the claim row, get a presigned PUT
    upload → browser PUTs the original to R2
    commit → server reads EXIF, stamps captured_at, rule 4 fires
    if refused: stop. Report. Do not touch the remaining pairs.
```

### Why not upload them in parallel

Uploading is the slow part and the obvious thing to overlap. It cannot be done
safely: `init` for pair *n+1* has to happen after pair *n* exists, or rule 2
refuses it — and if all the rows are created upfront, a rule-4 failure in the
middle deletes a row that later rows have already built on top of, leaving the
gap described in B6.

A batch of four is four sequential round trips. That is the cost of the
guarantee that a stopped batch is always a clean prefix.

---

## 5. Not in scope

- **Plate OCR.** Still deferred. The player types every plate.
- **Reviewing in bulk.** The review screen is separate work; nothing here
  changes how a claim is approved or rejected.
- **The pre-launch history.** That is `seed_next`, and it involves no photos.
