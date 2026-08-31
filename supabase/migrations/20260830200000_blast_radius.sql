-- ============================================================================
-- Plate Chase — how much a rejection would cost
--
-- Rejecting a claim orphans every claim the submitter has above it: they stop
-- counting, stop advancing, and leave the review queue, until the rejection is
-- undone. §7 notes that one click can cost someone seventy finds and concludes
-- that undo has to be cheap. Cheap undo is worth having either way, but a
-- reviewer who can see the cost before clicking needs it less often.
--
-- Counted here rather than in the app so it uses the same definition of "still
-- stands" as the counts on the submit screen.
-- ============================================================================

create or replace view v_review_queue with (security_invoker = true) as
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
  prev.captured_at  as previous_captured_at,
  -- Claims of the submitter's that still stand above this one. Rejecting this
  -- claim is what would orphan them, so they are counted as they are now.
  (select count(*)::int
     from claims later
    where later.player_id = c.player_id
      and later.number    > c.number
      and is_active_claim(later.player_id, later.number, later.status))
                    as claims_after
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
