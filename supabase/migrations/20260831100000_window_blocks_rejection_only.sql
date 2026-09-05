-- ============================================================================
-- Plate Chase — the finality window blocks rejection, not approval
--
-- §7 says the window exists to stop retroactive *destruction*, and that undo
-- is unbounded because "a mistake discovered on day 15 is permanent, which is
-- the opposite of what the rule is for."
--
-- The window was applied to every verdict, which made that promise hollow.
-- Undoing a day-30 rejection restored the row and then stranded it: the claim
-- was pending again, but nobody could approve it, it was absent from the
-- queue, and the submitter's confirmed_count stayed short by one for good. The
-- window had been lifted from the undo but not from the re-judgement that undo
-- exists to reopen.
--
-- The same fault, without any undo: a claim nobody looked at for fourteen days
-- could never count, because "no auto-approval" means only a human can approve
-- it and by then no human is allowed to.
--
-- Approval is not destruction. It is now permitted at any age; only rejection
-- is bounded.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The guard: check the window only when the verdict is a rejection.
-- ----------------------------------------------------------------------------
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
    -- Only rejection is bounded by the window. Approving an old claim takes
    -- nothing away from anyone, and refusing it is what left undone
    -- rejections and unreviewed claims permanently uncountable.
    if new.status = 'rejected'
       and now() - old.created_at >= make_interval(days => finality_days()) then
      raise exception 'claim is past the % day finality window and can no longer be rejected',
        finality_days()
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


-- ----------------------------------------------------------------------------
-- The policy: the window moves from USING to WITH CHECK.
--
-- USING is evaluated against the row as it stands, so it cannot tell an
-- approval from a rejection — both are updates to a pending claim. WITH CHECK
-- sees the new row, so it can bound rejection alone. It also raises rather
-- than quietly matching zero rows, which is what a reviewer needs to be told.
-- ----------------------------------------------------------------------------
drop policy claims_review on claims;

create policy claims_review on claims
  for update to authenticated
  using (
    (status = 'pending'
      and player_id <> auth.uid()
      and uploaded_at is not null)
    or
    (status = 'rejected' and (reviewed_by = auth.uid() or is_admin()))
  )
  with check (
    status <> 'rejected'
    or now() - created_at < make_interval(days => finality_days())
  );


-- ----------------------------------------------------------------------------
-- The queue: an old claim is still reviewable, so it stays. It carries
-- whether rejection is still open, so the screen can say so rather than
-- offering a button the database will refuse.
-- ----------------------------------------------------------------------------
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
  (select count(*)::int
     from claims later
    where later.player_id = c.player_id
      and later.number    > c.number
      and is_active_claim(later.player_id, later.number, later.status))
                    as claims_after,
  now() - c.created_at < make_interval(days => finality_days())
                    as can_reject
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
  and is_active_claim(c.player_id, c.number, c.status)
order by c.created_at;
