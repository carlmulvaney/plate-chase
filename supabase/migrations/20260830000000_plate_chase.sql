-- ============================================================================
-- Plate Chase — initial schema
-- Postgres 15+ / Supabase.
--
-- Specification: docs/design/submit-path.md. Where this file and that document
-- disagree, the document is right and this file is a bug.
--
-- The division of labour, from §2 of the spec:
--
--   Rule 1  format         database  check constraint on `plate`
--   Rule 1  is California  human     not derivable from a plate number
--   Rule 2  correct target database  trigger — needs the player's other claims
--   Rule 3  real vehicle   human     nothing machine-side sees the image
--   Rule 3  photo matches  human
--   Rule 4  capture order  database  trigger, when capture time is present
--   Rule 5  cascade        derived   a query, never a stored mutation
--
-- Rule 5 is the one to hold on to: a rejection rewrites nothing. Whether a
-- claim counts is computed at read time (spec §6; functions in section 3
-- below). That is why undoing a rejection is a single-row update with no
-- repair logic, and why there is no cascade that can half-run.
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()


-- ============================================================================
-- 1. TABLES
-- ============================================================================

create table players (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 40),

  -- Pre-launch position: the number the player was *hunting* at launch, which
  -- is how the players describe their own position (69, 104, 112). It sets the
  -- opening target, tells rule 4 that a first in-app claim legitimately has no
  -- predecessor photo, and anchors the leaderboard count. Deliberately not
  -- backfilled as hundreds of photo-less rows — see spec §4.
  seed_next    int not null default 0 check (seed_next between 0 and 1000),

  is_admin     boolean not null default false
);

comment on column players.seed_next is
  'Number the player was hunting at launch. Set after signup by scripts/seed.mjs; this migration seeds no player rows, because players.id references auth.users.';


create type claim_status as enum ('pending', 'approved', 'rejected');

comment on type claim_status is
  'The reviewer verdict on this claim alone, and nothing else. Whether a claim counts is derived (spec §6), not stored here. Three values; a fourth is a spec change.';


create table claims (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references players(id) on delete cascade,
  number       int  not null check (number between 0 and 999),
  plate        text not null check (plate ~ '^[0-9][A-Z]{3}[0-9]{3}$'),
  photo_key    text not null,

  uploaded_at  timestamptz,               -- null until the R2 upload is confirmed
  captured_at  timestamptz,               -- from EXIF; null if the photo carried none
  gps_lat      numeric check (gps_lat between -90 and 90),
  gps_lon      numeric check (gps_lon between -180 and 180),

  status       claim_status not null default 'pending',
  reviewed_by  uuid references players(id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),

  -- the claimed number must be the plate's own last three digits
  constraint number_matches_plate check (number = right(plate, 3)::int),
  -- a reviewer cannot be the submitter
  constraint no_self_review check (reviewed_by is null or reviewed_by <> player_id),
  -- a coordinate is a pair or it is nothing
  constraint gps_is_a_pair check ((gps_lat is null) = (gps_lon is null)),
  -- a verdict carries both who and when, or neither
  constraint review_stamp_is_complete check ((reviewed_by is null) = (reviewed_at is null)),
  -- an unreviewed claim carries no reviewer
  constraint pending_claims_are_unreviewed check (status <> 'pending' or reviewed_by is null)
);

-- At most one live claim per player per number. A rejected claim is not live,
-- so a player may re-claim a number they were rejected on.
create unique index one_live_claim_per_number
  on claims (player_id, number)
  where status <> 'rejected';

-- The derived functions in section 3 all walk one player's claims by number.
create index claims_by_player_number on claims (player_id, number, status);

-- The review queue.
create index claims_pending_queue on claims (created_at)
  where status = 'pending';


-- Append-only log of review actions. A claim's status is the current verdict;
-- this is the story. Without it, pending -> rejected -> pending -> approved
-- collapses to a single word and an undone rejection leaves no trace — which
-- matters, because a rejection temporarily wipes someone's streak.
create table claim_review_events (
  id         uuid primary key default gen_random_uuid(),
  claim_id   uuid not null references claims(id) on delete cascade,
  actor_id   uuid not null references players(id),
  action     text not null check (action in ('approve', 'reject', 'undo_reject')),
  note       text,
  created_at timestamptz not null default now()
);

create index claim_review_events_by_claim on claim_review_events (claim_id, created_at);


create table app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references players(id)
);

-- Read at review time so an admin can change the window without a deploy.
insert into app_config (key, value) values ('finality_days', '14');


-- ============================================================================
-- 2. HELPERS
--
-- security definer throughout: these are called from RLS policies and from
-- triggers, so they must not themselves be filtered by the policies they are
-- helping to evaluate. search_path is pinned so a caller cannot shadow the
-- tables they read.
-- ============================================================================

create or replace function finality_days() returns int
  language sql stable security definer set search_path = public
as $fn$
  select coalesce(
    (select (value #>> '{}')::int from app_config where key = 'finality_days'),
    14
  );
$fn$;

create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public
as $fn$
  select coalesce((select is_admin from players where id = auth.uid()), false);
$fn$;


-- ============================================================================
-- 3. RULE 5 AS A DERIVED VALUE  (spec §6)
--
-- Nothing is rewritten when a rejection lands. These functions are the single
-- definition of a player's position; the view in section 4 and the application
-- both read them rather than restating the formula.
-- ============================================================================

-- The number of a player's earliest rejection, or null if they have none.
-- Everything at or above it is void, whatever its own status says.
create or replace function first_rejected_number(p_player uuid) returns int
  language sql stable security definer set search_path = public
as $fn$
  select min(number) from claims
   where player_id = p_player and status = 'rejected';
$fn$;

-- Claims that still stand: not rejected themselves, and below the first
-- rejection. A pending claim above a rejection is orphaned — it neither counts
-- nor blocks, and the player may delete it (policy claims_delete_own_dead).
create or replace function is_active_claim(p_player uuid, p_number int, p_status claim_status)
  returns boolean
  language sql stable security definer set search_path = public
as $fn$
  select p_status in ('pending', 'approved')
     and coalesce(p_number < first_rejected_number(p_player), true);
$fn$;

-- The only number this player may claim next. Counts pending claims, not just
-- approved: an unreviewed claim still advances you.
create or replace function next_target(p_player uuid) returns int
  language sql stable security definer set search_path = public
as $fn$
  select greatest(
    p.seed_next,
    coalesce(
      (select max(c.number) + 1
         from claims c
        where c.player_id = p_player
          and is_active_claim(p_player, c.number, c.status)),
      p.seed_next
    )
  )
  from players p where p.id = p_player;
$fn$;

-- Leaderboard count: the pre-launch baseline plus approved claims that still
-- stand. Pending claims advance the target but do not count here.
create or replace function confirmed_count(p_player uuid) returns int
  language sql stable security definer set search_path = public
as $fn$
  select p.seed_next + (
    select count(*)
      from claims c
     where c.player_id = p_player
       and c.status = 'approved'
       and coalesce(c.number < first_rejected_number(p_player), true)
  )::int
  from players p where p.id = p_player;
$fn$;


-- ============================================================================
-- 4. READ MODEL
--
-- security_invoker so the querying user's RLS applies to the underlying rows.
-- One definition of each derived value, read from here by the app and never
-- recomputed in a component.
-- ============================================================================

create view v_player_state with (security_invoker = true) as
select
  p.id                        as player_id,
  p.display_name,
  p.seed_next,
  first_rejected_number(p.id) as first_rejected,
  next_target(p.id)           as next_target,
  confirmed_count(p.id)       as confirmed_count
from players p;


-- ============================================================================
-- 5. RULE 2 — CORRECT TARGET  (spec §5)
--
-- Needs to see the player's other claims, so it is a trigger rather than a
-- check constraint.
-- ============================================================================

create or replace function claims_check_target() returns trigger
  language plpgsql security definer set search_path = public
as $fn$
declare
  expected int;
begin
  expected := next_target(new.player_id);

  if expected is null then
    raise exception 'no player row for %', new.player_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.number <> expected then
    raise exception 'rule 2: next target is %, not %', expected, new.number
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger trg_claims_before_insert_check_target
  before insert on claims
  for each row execute function claims_check_target();


-- ============================================================================
-- 6. RULE 4 — CAPTURE ORDER  (spec §5)
--
-- Fires on UPDATE, not INSERT, and that is deliberate: captured_at does not
-- exist at insert time. The row is created in step 1 of the handshake, the
-- photo is uploaded in step 2, and EXIF is read and stamped in step 4 — so the
-- earliest moment this rule *can* be checked is the update that sets it.
--
-- What happens on violation is the caller's job: the confirm handler deletes
-- the claim row and the R2 object, so a failing claim never reaches review and
-- leaves nothing behind.
--
-- Missing capture time is not a rejection. It is a question a person answers,
-- so the claim passes and goes to review with both timestamps on screen.
-- ============================================================================

create or replace function claims_check_capture_order() returns trigger
  language plpgsql security definer set search_path = public
as $fn$
declare
  prev  record;
begin
  if new.captured_at is null then
    return new;                          -- no capture time: route to review
  end if;

  select c.captured_at into prev
    from claims c
   where c.player_id = new.player_id
     and c.number    = new.number - 1
     and c.status in ('pending', 'approved');

  -- No predecessor: the previous plate predates the app (number <= seed_next).
  -- Passes vacuously.
  if not found then
    return new;
  end if;

  -- Predecessor carries no capture time of its own: nothing to compare against.
  -- Route to review.
  if prev.captured_at is null then
    return new;
  end if;

  if new.captured_at <= prev.captured_at then
    raise exception 'rule 4: photo for % was captured %, not after its predecessor at %',
      new.number, new.captured_at, prev.captured_at
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

create trigger trg_claims_before_capture_stamped_check_order
  before update of captured_at on claims
  for each row
  when (new.captured_at is not null and old.captured_at is distinct from new.captured_at)
  execute function claims_check_capture_order();


-- ============================================================================
-- 7. UPDATE GUARD
--
-- RLS says which rows may be updated. It cannot say which columns changed,
-- because a WITH CHECK clause cannot see the old row. This trigger is that
-- other half: evidence is frozen, upload metadata is write-once, and only the
-- three status transitions the spec describes are legal.
-- ============================================================================

create or replace function claims_guard_update() returns trigger
  language plpgsql security definer set search_path = public
as $fn$
declare
  actor uuid := auth.uid();
begin
  -- Evidence is frozen. A reviewer opening a claim must not be able to edit
  -- the thing they are reviewing.
  if new.player_id  is distinct from old.player_id
  or new.number     is distinct from old.number
  or new.plate      is distinct from old.plate
  or new.photo_key  is distinct from old.photo_key
  or new.created_at is distinct from old.created_at then
    raise exception 'claim evidence is immutable'
      using errcode = 'check_violation';
  end if;

  -- Upload metadata is written once, by the confirm step.
  if old.uploaded_at is not null and new.uploaded_at is distinct from old.uploaded_at then
    raise exception 'uploaded_at is write-once' using errcode = 'check_violation';
  end if;
  if old.captured_at is not null and new.captured_at is distinct from old.captured_at then
    raise exception 'captured_at is write-once' using errcode = 'check_violation';
  end if;
  if old.gps_lat is not null and new.gps_lat is distinct from old.gps_lat then
    raise exception 'gps is write-once' using errcode = 'check_violation';
  end if;

  if new.status = old.status then
    return new;                                     -- the confirm step
  end if;

  if actor is null then
    raise exception 'a verdict needs a signed-in reviewer'
      using errcode = 'insufficient_privilege';
  end if;

  -- pending -> approved / rejected
  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    if old.uploaded_at is null then
      raise exception 'claim has no photo yet' using errcode = 'check_violation';
    end if;
    if actor = old.player_id then
      raise exception 'a player cannot review their own claim'
        using errcode = 'insufficient_privilege';
    end if;
    if now() - old.created_at >= make_interval(days => finality_days()) then
      raise exception 'claim is past the % day finality window', finality_days()
        using errcode = 'check_violation';
    end if;
    new.reviewed_by := actor;
    new.reviewed_at := now();
    return new;

  -- rejected -> pending (undo). Allowed at any time, including past the
  -- window: the window exists to stop retroactive destruction, and undo only
  -- ever restores.
  elsif old.status = 'rejected' and new.status = 'pending' then
    if actor <> old.reviewed_by and not is_admin() then
      raise exception 'only the original rejector or an admin may undo a rejection'
        using errcode = 'insufficient_privilege';
    end if;
    new.reviewed_by := null;
    new.reviewed_at := null;
    return new;
  end if;

  raise exception 'illegal status transition % to %', old.status, new.status
    using errcode = 'check_violation';
end;
$fn$;

create trigger trg_claims_before_update_guard
  before update on claims
  for each row execute function claims_guard_update();


-- ============================================================================
-- 8. REVIEW LOG
--
-- Written by trigger rather than by the application, so it cannot be forgotten
-- on a code path that changes status some other way. There is no insert policy
-- on claim_review_events; this security definer function is the only writer,
-- and nothing anywhere updates or deletes. Append-only in practice, not merely
-- by convention.
-- ============================================================================

create or replace function claims_log_review() returns trigger
  language plpgsql security definer set search_path = public
as $fn$
begin
  insert into claim_review_events (claim_id, actor_id, action)
  values (
    new.id,
    auth.uid(),
    case
      when new.status = 'approved' then 'approve'
      when new.status = 'rejected' then 'reject'
      else 'undo_reject'
    end
  );
  return null;
end;
$fn$;

create trigger trg_claims_after_status_change_log
  after update of status on claims
  for each row
  when (old.status is distinct from new.status)
  execute function claims_log_review();


-- ============================================================================
-- 9. SIGNUP
-- ============================================================================

create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public
as $fn$
begin
  insert into players (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(new.email, '@', 1)
    )
  );
  return new;
end;
$fn$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ============================================================================
-- 10. ROW-LEVEL SECURITY
--
-- Enabled on every table, no exceptions. The policies are the permission
-- model; a hidden button is a courtesy, not a control.
--
-- Three friends playing one game: everyone reads everything. The constraints
-- are all on writing.
-- ============================================================================

alter table players             enable row level security;
alter table claims              enable row level security;
alter table claim_review_events enable row level security;
alter table app_config          enable row level security;

-- players ---------------------------------------------------------------
create policy players_read on players
  for select to authenticated using (true);

-- Own row only. is_admin and seed_next are guarded by the trigger below,
-- because a policy cannot say which columns changed.
create policy players_update_own on players
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- No insert policy: rows arrive only via handle_new_user().

create or replace function players_guard_update() returns trigger
  language plpgsql security definer set search_path = public
as $fn$
begin
  -- A null auth.uid() means there is no user session: the service role, or a
  -- direct psql connection. Both are already trusted (service_role bypasses
  -- RLS outright), and this is the path scripts/seed.mjs uses to write the
  -- launch values for seed_next. Verdicts on claims deliberately do NOT get
  -- this exemption — see claims_guard_update(), where a null actor is refused,
  -- because "no auto-approval" means a human, not the system, decides.
  if auth.uid() is not null and not is_admin() then
    if new.is_admin  is distinct from old.is_admin
    or new.seed_next is distinct from old.seed_next then
      raise exception 'only an admin may change is_admin or seed_next'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$fn$;

create trigger trg_players_before_update_guard
  before update on players
  for each row execute function players_guard_update();

-- claims ----------------------------------------------------------------
create policy claims_read on claims
  for select to authenticated using (true);

create policy claims_insert_own on claims
  for insert to authenticated
  with check (player_id = auth.uid() and status = 'pending');

-- The submitter finishing their own upload (step 4 of the handshake). The
-- guard trigger holds it to the write-once columns.
create policy claims_confirm_own_upload on claims
  for update to authenticated
  using (player_id = auth.uid() and status = 'pending' and uploaded_at is null)
  with check (player_id = auth.uid());

-- Reviewing someone else's claim, and undoing a rejection you made. The
-- eligibility details are re-checked in the guard trigger; this clause decides
-- which rows may be touched at all.
create policy claims_review on claims
  for update to authenticated
  using (
    (status = 'pending'
      and player_id <> auth.uid()
      and uploaded_at is not null
      and now() - created_at < make_interval(days => finality_days()))
    or
    (status = 'rejected' and (reviewed_by = auth.uid() or is_admin()))
  )
  with check (true);

-- A player may delete their own claims that carry no weight: ones orphaned
-- above their first rejection (which would otherwise deadlock
-- one_live_claim_per_number when they re-advance past that number), and ones
-- whose upload never completed.
create policy claims_delete_own_dead on claims
  for delete to authenticated
  using (
    player_id = auth.uid()
    and status = 'pending'
    and (
      uploaded_at is null
      or number > coalesce(first_rejected_number(auth.uid()), 2147483647)
    )
  );

-- claim_review_events ---------------------------------------------------
create policy review_events_read on claim_review_events
  for select to authenticated using (true);
-- No insert, update, or delete policy. claims_log_review() is the only writer.

-- app_config ------------------------------------------------------------
create policy app_config_read on app_config
  for select to authenticated using (true);

create policy app_config_admin_write on app_config
  for all to authenticated
  using (is_admin()) with check (is_admin());
