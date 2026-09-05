-- ============================================================================
-- Plate Chase — a claim nobody objected to counts, and says so
--
-- Reopens "No auto-approval" deliberately. §8 deferred it and named the shape
-- it should take if ever adopted: "a derived effective_status (pending past
-- some age reads as approved) rather than a scheduled job that mutates rows,
-- for the same reason rule 5 is derived in §6." This is that.
--
-- The reason is not review backlog. Past the finality window a claim cannot be
-- rejected, so its only remaining outcomes are "someone clicks approve" and
-- "nobody ever does, and it never counts". The click carries no judgement,
-- because the judgement it would express is no longer available. Asking for it
-- is asking for a formality, and withholding the find until someone performs
-- that formality is an arbitrary penalty for nobody having looked in time.
--
-- Nothing is written. `status` still has three values and still means the
-- reviewer's verdict; a claim that auto-approves is `pending` with
-- `reviewed_by` null, which is the truthful record — no human ruled on this,
-- and the window shut. There is no SYSTEM actor, because no actor acted.
--
-- Two consequences, neither hidden:
--   * A confirmed count can rise overnight with no request and no write.
--   * Changing finality_days is retroactive. Lower it and claims flip to
--     auto-approved at once; raise it and they revert, and counts fall.
--     That is the price of it being reversible rather than stamped in.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Four values out of three. `stable`, not `immutable`: it reads the clock and
-- app_config, so it cannot appear in a constraint or an index — and nothing
-- needs it to.
-- ----------------------------------------------------------------------------
create or replace function effective_status(p_status claim_status, p_created_at timestamptz)
  returns text
  language sql stable security definer set search_path = public
as $fn$
  select case
    when p_status = 'pending'
     and now() - p_created_at >= make_interval(days => finality_days())
    then 'auto_approved'
    else p_status::text
  end;
$fn$;

comment on function effective_status(claim_status, timestamptz) is
  'pending | approved | auto_approved | rejected. auto_approved is derived, never stored: the claim is still pending and still unreviewed, but past the window where anyone could reject it.';


-- ----------------------------------------------------------------------------
-- Counting: an unobjected claim counts, and a claim nobody can act on is no
-- longer reported as awaiting review.
-- ----------------------------------------------------------------------------
create or replace function confirmed_count(p_player uuid) returns int
  language sql stable security definer set search_path = public
as $fn$
  select p.seed_next + (
    select count(*)
      from claims c
     where c.player_id = p_player
       and effective_status(c.status, c.created_at) in ('approved', 'auto_approved')
       and coalesce(c.number < first_rejected_number(p_player), true)
  )::int
  from players p where p.id = p_player;
$fn$;

create or replace function pending_count(p_player uuid) returns int
  language sql stable security definer set search_path = public
as $fn$
  select count(*)::int
    from claims c
   where c.player_id = p_player
     and effective_status(c.status, c.created_at) = 'pending'
     and coalesce(c.number < first_rejected_number(p_player), true);
$fn$;

create or replace function auto_approved_count(p_player uuid) returns int
  language sql stable security definer set search_path = public
as $fn$
  select count(*)::int
    from claims c
   where c.player_id = p_player
     and effective_status(c.status, c.created_at) = 'auto_approved'
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
  pending_count(p.id)         as pending_count,
  auto_approved_count(p.id)   as auto_approved_count
from players p;


-- ----------------------------------------------------------------------------
-- The queue holds what still needs deciding, and nothing else.
--
-- can_reject is gone with it: everything in the queue is inside the window by
-- construction, so the column was always true and the screen had a state it
-- could no longer reach. Dropped rather than replaced, since removing a column
-- is not something create or replace will do.
-- ----------------------------------------------------------------------------
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
  prev.captured_at  as previous_captured_at,
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
where effective_status(c.status, c.created_at) = 'pending'
  and c.uploaded_at is not null
  and c.player_id <> auth.uid()
  and is_active_claim(c.player_id, c.number, c.status)
order by c.created_at;


-- ----------------------------------------------------------------------------
-- What went through unobjected, so it is visible rather than silent.
--
-- `settled_at` is computed, not recorded: the moment a claim auto-approves is
-- exactly when its window closed. Nothing had to be written down to know it.
-- ----------------------------------------------------------------------------
create or replace view v_auto_approved with (security_invoker = true) as
select
  c.id,
  c.player_id,
  sub.display_name                                       as submitter,
  c.number,
  c.plate,
  c.photo_key,
  c.created_at,
  c.created_at + make_interval(days => finality_days())  as settled_at
from claims c
join players sub on sub.id = c.player_id
where effective_status(c.status, c.created_at) = 'auto_approved'
  and coalesce(c.number < first_rejected_number(c.player_id), true)
order by c.number;
