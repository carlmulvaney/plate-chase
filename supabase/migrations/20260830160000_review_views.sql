-- ============================================================================
-- Plate Chase — the review queue, and the rejections that can be undone
--
-- Both are derived. Nothing here stores who may review what; the same facts
-- the RLS policies read are read again to decide what is worth showing.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The queue
--
-- A claim is reviewable when it is pending, its photo has arrived, the reviewer
-- is not the submitter, and it is inside the finality window (spec §7).
--
-- Plus one filter the spec implies rather than states: a claim orphaned above
-- the submitter's first rejection is excluded. Per §6 it neither counts nor
-- blocks, so no verdict on it changes anything — putting it in the queue asks
-- a reviewer to judge something already moot. Rejecting one claim can
-- therefore empty the queue of every claim above it, and undoing that
-- rejection brings them all back unreviewed, because nothing was written to
-- them on the way out.
--
-- The predecessor's capture time is carried here deliberately. Rule 4 is
-- enforced on a value no human ever sees; a reviewer who cannot see both times
-- cannot catch the case where the ordering is wrong but well formed.
-- ----------------------------------------------------------------------------
create or replace view v_review_queue with (security_invoker = true) as
select
  c.id,
  c.player_id,
  sub.display_name              as submitter,
  c.number,
  c.plate,
  c.photo_key,
  c.captured_at,
  c.created_at,
  (select prev.captured_at
     from claims prev
    where prev.player_id = c.player_id
      and prev.number    = c.number - 1
      and prev.status in ('pending', 'approved'))  as previous_captured_at,
  c.number - 1                                     as previous_number
from claims c
join players sub on sub.id = c.player_id
where c.status = 'pending'
  and c.uploaded_at is not null
  and c.player_id <> auth.uid()
  and now() - c.created_at < make_interval(days => finality_days())
  and is_active_claim(c.player_id, c.number, c.status)
order by c.created_at;


-- ----------------------------------------------------------------------------
-- Rejections
--
-- Undo has to live somewhere, and a rejected claim is not in the queue. This
-- lists them with whether the viewer may actually undo: the original rejector
-- or an admin, at any time, including past the finality window — the window
-- exists to stop retroactive destruction, and undo only ever restores.
--
-- `can_undo` decides what to render. It is not what permits the update: the
-- claims_review policy and the update guard do that, and they are checked
-- whatever the UI shows.
-- ----------------------------------------------------------------------------
create or replace view v_rejected_claims with (security_invoker = true) as
select
  c.id,
  c.number,
  c.plate,
  c.photo_key,
  sub.display_name                                  as submitter,
  rev.display_name                                  as rejected_by,
  c.reviewed_at,
  (c.reviewed_by = auth.uid() or is_admin())        as can_undo
from claims c
join players sub on sub.id = c.player_id
left join players rev on rev.id = c.reviewed_by
where c.status = 'rejected'
order by c.reviewed_at desc nulls last;
