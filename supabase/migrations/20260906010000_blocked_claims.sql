-- ============================================================================
-- Plate Chase — the claims a rejection has stranded, so their owner can see them
--
-- Spec §6: "Surface them in the UI as blocked rather than awaiting review."
-- Nothing did. A claim above someone's first rejection vanishes from every
-- screen — it is not in the review queue, not in pending_count, not in the
-- rejections list — so the player is told only which number was rejected and
-- never learns the photos above it still exist and count for nothing.
--
-- Defined as "not active", not as "number > first_rejected". is_active_claim
-- owns that comparison; restating it here would be a second copy to keep in
-- step. Approved claims are included: a claim approved before a lower one was
-- rejected is stranded in exactly the same way, and hiding it would be the
-- same silence in a different place.
-- ============================================================================

create view v_blocked_claims with (security_invoker = true) as
select
  c.id,
  c.player_id,
  c.number,
  c.plate,
  c.photo_key,
  c.status,
  first_rejected_number(c.player_id) as blocked_by,
  -- claims_delete_own_dead permits pending only; an approved claim carries a
  -- reviewer's verdict and is not the submitter's to erase.
  (c.status = 'pending')             as can_delete
from claims c
where c.status <> 'rejected'
  and not is_active_claim(c.player_id, c.number, c.status)
order by c.number;
