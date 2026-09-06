-- ============================================================================
-- Plate Chase — a re-claimed number is no longer a wall
--
-- one_live_claim_per_number excludes rejected rows so a player may shoot a
-- rejected number again (spec §6: a rejection sends you back to that number).
-- But first_rejected_number reported the rejected row whether or not it had
-- been replaced, and everything downstream tests `number < first_rejected`.
-- The replacement therefore sat at the rejection rather than below it: never
-- active, never counted, and the target never moved off that number. Approving
-- it changed nothing. A rejection was permanent.
--
-- A rejected claim that a live claim has taken the place of is spent. Only
-- rejections still standing alone hold the line.
--
-- One function changes. next_target, confirmed_count, pending_count,
-- auto_approved_count, is_active_claim, the review views and
-- claims_delete_own_dead all read it and inherit the correction — which is the
-- reason the streak was derived from one place to begin with.
-- ============================================================================

create or replace function first_rejected_number(p_player uuid) returns int
  language sql stable security definer set search_path = public
as $fn$
  select min(r.number)
    from claims r
   where r.player_id = p_player
     and r.status = 'rejected'
     -- one_live_claim_per_number allows at most one of these, so its presence
     -- means the number was re-claimed and this rejection has been answered.
     and not exists (
       select 1 from claims live
        where live.player_id = r.player_id
          and live.number    = r.number
          and live.status   <> 'rejected'
     );
$fn$;
