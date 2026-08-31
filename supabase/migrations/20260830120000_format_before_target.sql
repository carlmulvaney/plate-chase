-- ============================================================================
-- Plate Chase — let rule 1 speak before rule 2
--
-- Postgres runs BEFORE ROW triggers before it evaluates check constraints, so
-- claims_check_target() always answered first. A plate that was both malformed
-- and aimed at the wrong target reported only the target:
--
--   insert ... plate 'ABC0007', number 7   ->  "rule 2: next target is 2, not 7"
--
-- which tells someone who typed nonsense to go and think about their target.
-- Rule 1 is the more basic failure and should be the one they hear about.
--
-- Nothing about either rule changes here — only which one gets to speak when
-- both are broken.
-- ============================================================================

-- One definition of what a plate looks like, so the constraint and the trigger
-- cannot drift apart. Immutable, which is what lets a check constraint call it.
create or replace function is_valid_plate(p text) returns boolean
  language sql immutable
as $fn$
  select p ~ '^[0-9][A-Z]{3}[0-9]{3}$';
$fn$;

comment on function is_valid_plate(text) is
  'Rule 1, the machine-checkable half. Whether the plate is genuinely a California plate is a human question and is not derivable from the number.';

-- Same rule, now expressed through the function. The old inline constraint is
-- superseded rather than altered: a check constraint cannot be modified in
-- place, so it is dropped and recreated in one transaction.
alter table claims drop constraint claims_plate_check;
alter table claims add constraint claims_plate_check check (is_valid_plate(plate));


-- Rule 2 now declines to speak over rule 1.
create or replace function claims_check_target() returns trigger
  language plpgsql security definer set search_path = public
as $fn$
declare
  expected int;
begin
  -- If the plate is not a plate, its target is not the interesting problem.
  -- Return and let claims_plate_check refuse, so the error names what is
  -- actually wrong. The constraint remains the sole authority on rule 1;
  -- this only defers to it.
  if not is_valid_plate(new.plate) then
    return new;
  end if;

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
