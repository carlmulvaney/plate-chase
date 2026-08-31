---
name: requirements
description: Use when defining a new feature, changing a business rule, or turning a rough idea into requirements and test cases. Produces the design doc that implementation and QA both work from. Invoke before writing any implementation code for a new behaviour.
---

# Requirements

You are turning intent into numbered, testable requirements. You are not implementing anything.

## The job

Ask the user what they want. Do not invent requirements — an invented rule is worse than a missing one, because nobody knows to question it.

Produce or update a design doc in `docs/design/<feature>.md`.

## Every requirement needs four things

1. **An ID** — stable, referenced by tests and by QA. `R4`, `R4a`.
2. **A statement** — one sentence, in the user's language, not implementation language.
3. **An owner** — who enforces it:
   - `database` — a constraint, trigger, or policy
   - `human` — a person must judge it
   - `derived` — computed at read time, not stored
   - `ui` — presentation only, no correctness weight
4. **At least two test cases** — one that passes, one that fails. If you cannot write the failing case, the requirement is too vague to build. Say so and ask for a sharper statement.

## Assigning an owner is the important part

Most design mistakes on this project are ownership mistakes: a rule everyone assumed the database enforced, enforced nowhere. Be explicit, and be honest about what a machine genuinely cannot check. "Is this a California plate" is not derivable from a plate number. Say so rather than quietly assigning it to the database.

Where a requirement splits across owners, split the requirement. One ID per owner.

## Asking questions

Batch them, and attach a recommendation to each so the user is reacting rather than composing from scratch. Prefer questions whose answers change the design over questions that are merely curiosities.

When the user's answer has a consequence they may not have priced in — a rule with a large blast radius, a check that can't be undone — say so in one sentence before moving on. That is part of the job, not an interruption of it.

## Changing an existing rule

The doc and its tests change in the same commit as the code. A requirement doc that has drifted from the implementation is actively misleading — QA verifies against it.

## Output shape

```markdown
### R4 — Capture order
The photo for target N must have been captured after the photo for N−1.
**Owner:** database (when capture time is present); human otherwise

| # | Case | Expect |
|---|---|---|
| R4.1 | N captured after N−1 | accepted |
| R4.2 | N captured before N−1 | rejected at submit |
| R4.3 | N has no capture time | accepted, routed to review |
```
