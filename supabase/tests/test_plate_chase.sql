-- ============================================================================
-- Plate Chase — rule tests
--
-- Every rule in docs/design/submit-path.md gets at least one passing case and
-- one failing case. The failing case is the point: a constraint with only a
-- happy-path test is untested, because the test would pass identically against
-- a schema where the constraint does not exist.
--
-- Run against a scratch database only, never the real project — the stub
-- replaces auth.uid(). Runbook:
--
--   createdb pc_test
--   psql -d pc_test -c "create extension if not exists pgcrypto;"
--   psql -d pc_test -f supabase/tests/_local_stub.sql
--   psql -d pc_test -f supabase/migrations/20260830000000_plate_chase.sql
--   psql -d pc_test -f supabase/tests/test_plate_chase.sql
--
-- Expect: 44 ok, 0 FAIL. The file exits non-zero if any test fails, and is
-- re-runnable against a fresh database.
-- ============================================================================

\set ON_ERROR_STOP on
set client_min_messages = warning;


-- ============================================================================
-- Harness
-- ============================================================================

create table t_results (
  n      serial primary key,
  label  text not null,
  passed boolean not null,
  detail text
);
grant all on t_results to public;
grant all on sequence t_results_n_seq to public;

-- Run p_sql and record whether it did or did not raise, as expected.
create or replace function t_run(p_label text, p_sql text, p_expect_error boolean)
  returns void language plpgsql as $fn$
declare
  passed boolean;
  detail text := '';
begin
  begin
    execute p_sql;
    passed := not p_expect_error;
    if p_expect_error then detail := 'expected an error, none was raised'; end if;
  exception when others then
    passed := p_expect_error;
    detail := sqlerrm;
  end;
  insert into t_results (label, passed, detail) values (p_label, passed, detail);
end;
$fn$;

-- Record a boolean assertion.
create or replace function t_true(p_label text, p_cond boolean, p_detail text default '')
  returns void language plpgsql as $fn$
begin
  insert into t_results (label, passed, detail)
  values (p_label, coalesce(p_cond, false), p_detail);
end;
$fn$;

-- Act as a given player for subsequent statements.
create or replace function t_as(p_uid uuid) returns void language plpgsql as $fn$
begin
  perform set_config('test.uid', coalesce(p_uid::text, ''), false);
end;
$fn$;

grant execute on function t_run(text, text, boolean)  to public;
grant execute on function t_true(text, boolean, text) to public;
grant execute on function t_as(uuid)                  to public;


-- ============================================================================
-- Fixtures
--
-- Ann is hunting 69, Bob 104, Cid 112. Cid is the admin. These are the real
-- launch values from spec §4.
-- ============================================================================

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ann@example.com', '{"display_name":"Ann"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob@example.com', '{"display_name":"Bob"}'),
  ('cccccccc-0000-0000-0000-000000000003', 'cid@example.com', '{"display_name":"Cid"}');

update players set seed_next = 69  where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update players set seed_next = 104 where id = 'bbbbbbbb-0000-0000-0000-000000000002';
update players set seed_next = 112, is_admin = true
  where id = 'cccccccc-0000-0000-0000-000000000003';


-- ============================================================================
-- Signup
-- ============================================================================

select t_true('01 signup creates a player row with the metadata name',
  (select display_name from players where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'Ann');

select t_true('02 seed_next sets the opening target before any claim',
  next_target('bbbbbbbb-0000-0000-0000-000000000002') = 104);


-- ============================================================================
-- Rule 1 — format  (database half; "is it California" is the reviewer's)
-- ============================================================================

select t_run('03 well-formed plate is accepted',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 69, '1ABC069', 'k/ann/69')$q$, false);

select t_run('04 lowercase plate is refused',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('bbbbbbbb-0000-0000-0000-000000000002', 104, '1abc104', 'k/bob/104')$q$, true);

select t_run('05 wrong plate shape is refused',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('bbbbbbbb-0000-0000-0000-000000000002', 104, 'ABC1104', 'k/bob/104')$q$, true);

-- Ordering of the two rules, not a new rule. Postgres runs BEFORE ROW triggers
-- before check constraints, so rule 2 spoke first and a plate that was both
-- malformed and wrongly targeted reported only its target.
select t_run('05a a malformed plate is refused for its FORMAT, not its target',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('bbbbbbbb-0000-0000-0000-000000000002', 7, 'ABC0007', 'k/bob/7')$q$, true);

select t_true('05b and the message names the plate, not the target',
  (select detail from t_results where label like '05a%') like '%claims_plate_check%',
  (select detail from t_results where label like '05a%'));

select t_run('06 number that is not the plate last three is refused',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('bbbbbbbb-0000-0000-0000-000000000002', 104, '1ABC105', 'k/bob/104')$q$, true);


-- ============================================================================
-- Rule 2 — target
-- ============================================================================

select t_true('07 a pending claim advances the target',
  next_target('aaaaaaaa-0000-0000-0000-000000000001') = 70);

select t_run('08 skipping ahead of the target is refused',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 72, '1ABC072', 'k/ann/72')$q$, true);

select t_run('09 re-claiming a number below the target is refused',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 69, '1ZZZ069', 'k/ann/69b')$q$, true);

select t_run('10 claiming below seed_next is refused',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('bbbbbbbb-0000-0000-0000-000000000002', 50, '1ABC050', 'k/bob/50')$q$, true);


-- ============================================================================
-- Rule 4 — capture order
--
-- Fires when captured_at is stamped at the confirm step, not at insert.
-- ============================================================================

-- Ann's 69 predates the app as far as rule 4 is concerned: no claim at 68.
select t_run('11 first claim has no predecessor, so any capture time passes',
  $q$update claims set uploaded_at = now(), captured_at = timestamptz '2026-08-01 10:00Z'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 69$q$, false);

select t_run('12 successor captured after its predecessor is accepted',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 70, '1ABC070', 'k/ann/70');
     update claims set uploaded_at = now(), captured_at = timestamptz '2026-08-02 10:00Z'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70$q$, false);

-- Insert outside the assertion: a failing t_run rolls its whole body back, so
-- bundling the insert with the update would silently undo the fixture and
-- leave the following tests asserting against a row that does not exist.
insert into claims (player_id, number, plate, photo_key)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 71, '1ABC071', 'k/ann/71');

select t_run('13 successor captured BEFORE its predecessor is refused',
  $q$update claims set uploaded_at = now(), captured_at = timestamptz '2026-07-01 10:00Z'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 71$q$, true);

select t_run('14 successor with no capture time passes, routed to review',
  $q$update claims set uploaded_at = now()
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 71$q$, false);

select t_true('15 a claim with no capture time still sits pending for a human',
  (select status from claims
    where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 71) = 'pending');


-- ============================================================================
-- one_live_claim_per_number
-- ============================================================================

-- one_live_claim_per_number is a backstop: in the normal path rule 2 already
-- makes a duplicate impossible, so an insert at 71 would be refused by the
-- target trigger and this test would pass without the index existing at all.
-- Disable that trigger so the index is what is actually under test.
alter table claims disable trigger trg_claims_before_insert_check_target;

select t_run('16 a second live claim on the same number is refused',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 71, '1QQQ071', 'k/ann/71b')$q$, true);

alter table claims enable trigger trg_claims_before_insert_check_target;


-- ============================================================================
-- Review — who may, and when
-- ============================================================================

select t_as('aaaaaaaa-0000-0000-0000-000000000001');
select t_run('17 a player cannot review their own claim',
  $q$update claims set status = 'approved'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 69$q$, true);

select t_as('bbbbbbbb-0000-0000-0000-000000000002');
select t_run('18 another player can approve it',
  $q$update claims set status = 'approved'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 69$q$, false);

select t_true('19 approval stamps the reviewer and the time',
  (select reviewed_by = 'bbbbbbbb-0000-0000-0000-000000000002' and reviewed_at is not null
     from claims where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 69));

select t_run('20 an approved claim cannot then be rejected',
  $q$update claims set status = 'rejected'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 69$q$, true);

-- A claim whose upload never completed has no evidence to judge.
insert into claims (player_id, number, plate, photo_key)
  values ('bbbbbbbb-0000-0000-0000-000000000002', 104, '1ABC104', 'k/bob/104');
select t_as('aaaaaaaa-0000-0000-0000-000000000001');
select t_run('21 a claim with no photo yet cannot be reviewed',
  $q$update claims set status = 'approved'
      where player_id = 'bbbbbbbb-0000-0000-0000-000000000002' and number = 104$q$, true);


-- ============================================================================
-- Update guard — evidence is frozen, upload metadata is write-once
-- ============================================================================

select t_run('22 the plate on a claim cannot be edited',
  $q$update claims set plate = '1ZZZ069'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 69$q$, true);

select t_run('23 the claimed number cannot be edited',
  $q$update claims set number = 999
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 69$q$, true);

select t_run('24 captured_at cannot be rewritten once set',
  $q$update claims set captured_at = timestamptz '2020-01-01 00:00Z'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 69$q$, true);


-- ============================================================================
-- Rule 5 — derived, not cascaded
--
-- Ann: 69 approved, 70 pending, 71 pending. Reject 70 and watch 71 stop
-- counting without anything being written to it.
-- ============================================================================

select t_as('bbbbbbbb-0000-0000-0000-000000000002');
update claims set status = 'rejected'
  where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70;

select t_true('25 the rejected row is the only row that changed',
  (select status from claims
    where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 71) = 'pending');

select t_true('26 next_target falls back to the rejected number',
  next_target('aaaaaaaa-0000-0000-0000-000000000001') = 70);

select t_true('27 confirmed_count keeps the approved claim below the rejection',
  confirmed_count('aaaaaaaa-0000-0000-0000-000000000001') = 70);

select t_true('27a pending_count counts claims that still stand',
  pending_count('aaaaaaaa-0000-0000-0000-000000000001') = 0,
  'expected 0: 69 is approved, 70 rejected, 71 orphaned above it');

select t_true('28 a pending claim above the rejection is orphaned, not counted',
  (select count(*) from claims
    where player_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      and is_active_claim('aaaaaaaa-0000-0000-0000-000000000001', number, status)) = 1);


-- ============================================================================
-- Undo — the reason rule 5 is derived
-- ============================================================================

select t_as('bbbbbbbb-0000-0000-0000-000000000002');
select t_run('29 the original rejector can undo their own rejection',
  $q$update claims set status = 'pending'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70$q$, false);

-- Reject it again so the remaining undo cases have something to undo.
update claims set status = 'rejected'
  where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70;

select t_as('aaaaaaaa-0000-0000-0000-000000000001');
select t_run('30 the submitter cannot undo their own rejection',
  $q$update claims set status = 'pending'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70$q$, true);

select t_as('cccccccc-0000-0000-0000-000000000003');
select t_run('31 an admin can undo a rejection',
  $q$update claims set status = 'pending'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70$q$, false);

select t_true('31a pending_count picks the claim back up after an undo',
  pending_count('aaaaaaaa-0000-0000-0000-000000000001') = 2,
  'expected 2: 70 and 71 both pending and below no rejection');

select t_true('32 undo restores the streak with no repair logic',
  next_target('aaaaaaaa-0000-0000-0000-000000000001') = 72
  and confirmed_count('aaaaaaaa-0000-0000-0000-000000000001') = 70);

select t_true('33 undo clears the reviewer stamp',
  (select reviewed_by is null and reviewed_at is null from claims
    where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70));


-- ============================================================================
-- Review log
-- ============================================================================

select t_true('34 every verdict and undo is logged in order',
  (select array_agg(e.action order by e.created_at) from claim_review_events e
     join claims c on c.id = e.claim_id
    where c.player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and c.number = 70)
  = array['reject','undo_reject','reject','undo_reject']);


-- ============================================================================
-- RLS — exercised as a real non-superuser. As superuser these would all pass
-- against a schema with no policies at all.
-- ============================================================================

set role authed;

select t_as('bbbbbbbb-0000-0000-0000-000000000002');
select t_true('35 a player can read every claim',
  (select count(*) from claims) >= 4);

select t_run('36 a player cannot submit a claim as someone else',
  $q$insert into claims (player_id, number, plate, photo_key)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 72, '1ABC072', 'k/forged')$q$, true);

select t_run('37 a non-admin cannot change their own seed_next',
  $q$update players set seed_next = 999
      where id = 'bbbbbbbb-0000-0000-0000-000000000002'$q$, true);

select t_run('38 a non-admin cannot make themselves admin',
  $q$update players set is_admin = true
      where id = 'bbbbbbbb-0000-0000-0000-000000000002'$q$, true);

-- An UPDATE whose USING clause excludes the row does not raise; it matches
-- zero rows. Asserting on the error would pass against no policy at all, so
-- assert on the value instead.
update app_config set value = '999' where key = 'finality_days';
select t_true('39 a non-admin cannot change the finality window',
  (select (value #>> '{}')::int from app_config where key = 'finality_days') = 14,
  'RLS let a non-admin write app_config');

select t_run('40 the review log has no insert policy, so nobody can forge one',
  $q$insert into claim_review_events (claim_id, actor_id, action)
     select id, 'bbbbbbbb-0000-0000-0000-000000000002', 'approve' from claims limit 1$q$, true);

reset role;


-- ============================================================================
-- Report
-- ============================================================================

select
  lpad(n::text, 2, '0') || '  ' ||
  case when passed then 'ok   ' else 'FAIL ' end ||
  label ||
  case when detail <> '' and not passed then '   <<< ' || detail else '' end
  as result
from t_results order by n;

select
  count(*) filter (where passed)       as passed,
  count(*) filter (where not passed)   as failed,
  count(*)                             as total
from t_results;

do $done$
declare failed int;
begin
  select count(*) into failed from t_results where not passed;
  if failed > 0 then
    raise exception '% test(s) failed', failed;
  end if;
end
$done$;
