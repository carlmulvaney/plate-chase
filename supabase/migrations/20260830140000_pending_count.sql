-- ============================================================================
-- Plate Chase — surface how many claims are waiting for a reviewer
--
-- v_player_state already carries confirmed_count. A player also wants to know
-- how many of their claims are sitting unreviewed: those advance their target
-- but do not yet count on the leaderboard, and with no auto-approval they can
-- sit there indefinitely.
--
-- Derived, like everything else in this view. Nothing is stored.
-- ============================================================================

-- Pending claims that still stand — same "below your first rejection" test
-- that confirmed_count applies, so the two numbers always describe the same
-- streak. Claims orphaned above a rejection are excluded: per spec §6 they
-- neither count nor block, and they belong on the review screen labelled as
-- blocked rather than being reported here as awaiting review.
create or replace function pending_count(p_player uuid) returns int
  language sql stable security definer set search_path = public
as $fn$
  select count(*)::int
    from claims c
   where c.player_id = p_player
     and c.status = 'pending'
     and coalesce(c.number < first_rejected_number(p_player), true);
$fn$;

create or replace view v_player_state with (security_invoker = true) as
select
  p.id                        as player_id,
  p.display_name,
  p.seed_next,
  first_rejected_number(p.id) as first_rejected,
  next_target(p.id)           as next_target,
  confirmed_count(p.id)       as confirmed_count,
  pending_count(p.id)         as pending_count
from players p;
