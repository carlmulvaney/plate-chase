-- ============================================================================
-- Plate Chase — tell "no previous plate" apart from "no capture time"
--
-- v_review_queue reported previous_number as number - 1 unconditionally, so a
-- claim on 000 announced a predecessor of -1, and previous_captured_at was
-- null whether the predecessor was missing or merely undated.
--
-- Those are different situations and a reviewer should not be shown the same
-- thing for both. A claim with no predecessor — the first of a run, or
-- anything at or below the player's seed_next — passed rule 4 vacuously, and
-- there is no ordering for a human to second-guess. A claim whose predecessor
-- exists but carries no capture time is the case §5 routes to review on
-- purpose, and it does want a human's attention.
--
-- The predecessor is now joined rather than computed, so its number is null
-- exactly when there isn't one.
-- ============================================================================

-- Dropped rather than replaced: the predecessor is now joined, which changes
-- the order of the last two columns, and CREATE OR REPLACE VIEW cannot
-- reorder them. Nothing depends on this view but the review page.
drop view if exists v_review_queue;

create view v_review_queue with (security_invoker = true) as
select
  c.id,
  c.player_id,
  sub.display_name  as submitter,
  c.number,
  c.plate,
  c.photo_key,
  c.captured_at,
  c.created_at,
  prev.number       as previous_number,
  prev.captured_at  as previous_captured_at
from claims c
join players sub on sub.id = c.player_id
left join lateral (
  select p.number, p.captured_at
    from claims p
   where p.player_id = c.player_id
     and p.number    = c.number - 1
     and p.status in ('pending', 'approved')
   limit 1
) prev on true
where c.status = 'pending'
  and c.uploaded_at is not null
  and c.player_id <> auth.uid()
  and now() - c.created_at < make_interval(days => finality_days())
  and is_active_claim(c.player_id, c.number, c.status)
order by c.created_at;
