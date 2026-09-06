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
-- Expect: 89 ok, 0 FAIL. The file exits non-zero if any test fails, and is
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

-- Under the authed role, because §7 assigns this to RLS: "the original
-- rejector or an admin. Enforced by RLS, not by hiding the button." Run as
-- superuser these passed with the policy's rejected branch weakened to a bare
-- status = 'rejected', because only the guard trigger was ever exercised.
set role authed;

select t_as('bbbbbbbb-0000-0000-0000-000000000002');
select t_run('29 the original rejector can undo their own rejection',
  $q$update claims set status = 'pending'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70$q$, false);

select t_true('29a and it actually went back to pending',
  (select status from claims
    where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70) = 'pending');

-- Reject it again so the remaining undo cases have something to undo.
update claims set status = 'rejected'
  where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70;

-- A policy that excludes a row does not raise; it matches nothing. So the
-- assertion is on the row, not on an error — an error-based test here would
-- pass against a schema with no policy at all.
select t_as('aaaaaaaa-0000-0000-0000-000000000001');
update claims set status = 'pending'
  where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70;

select t_true('30 the submitter cannot undo their own rejection',
  (select status from claims
    where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70) = 'rejected',
  'RLS let the submitter undo a rejection against them');

select t_as('cccccccc-0000-0000-0000-000000000003');
select t_run('31 an admin can undo a rejection',
  $q$update claims set status = 'pending'
      where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70$q$, false);

reset role;

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
-- The review queue  (v_review_queue)
--
-- State at this point: Ann has 69 approved, 70 pending (rejection undone),
-- 71 pending. Bob has 104 pending with no photo. Acting as Bob.
-- ============================================================================

set role authed;
select t_as('bbbbbbbb-0000-0000-0000-000000000002');

select t_true('41 the queue shows another player''s uploaded pending claims',
  (select count(*) from v_review_queue where player_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 2,
  (select coalesce(string_agg(number::text, ','), 'none') from v_review_queue));

-- Bob's 104 must have a photo before this means anything. Without it the
-- count is zero because of the upload filter, and removing the self filter
-- from the view leaves this test still passing — which it did.
reset role;
update claims set uploaded_at = now()
  where player_id = 'bbbbbbbb-0000-0000-0000-000000000002' and number = 104;
set role authed;
select t_as('bbbbbbbb-0000-0000-0000-000000000002');

select t_true('42 the queue never shows your own claims',
  (select count(*) from v_review_queue where player_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0,
  'Bob has an uploaded pending claim at 104; it must not be offered to Bob');

select t_true('43 the queue carries the predecessor capture time rule 4 compared',
  (select previous_captured_at is not null from v_review_queue where number = 70));

select t_true('43b a claim with a predecessor reports its number',
  (select previous_number from v_review_queue where number = 70) = 69);

-- What a rejection would cost, so a reviewer can see it before clicking.
-- Ann has 70 and 71 standing; rejecting 70 would orphan 71.
select t_true('43c the queue counts the claims a rejection would block',
  (select claims_after from v_review_queue where number = 70) = 1,
  (select 'got ' || claims_after::text from v_review_queue where number = 70));

select t_true('43d the topmost claim blocks nothing',
  (select claims_after from v_review_queue where number = 71) = 0);

reset role;

-- A claim with no predecessor must be distinguishable from one whose
-- predecessor merely has no capture time. Bob's 104 is his seed_next, so there
-- is no claim at 103 and rule 4 passed vacuously. Looked at as Ann, since the
-- queue never shows your own.
select t_as('aaaaaaaa-0000-0000-0000-000000000001');

select t_true('43a a claim with no predecessor reports no previous number',
  (select previous_number is null from v_review_queue where number = 104),
  'expected null — not 103, and certainly not -1');

set role authed;
select t_as('bbbbbbbb-0000-0000-0000-000000000002');

reset role;

-- A claim with no photo yet cannot be judged, so it is not offered. Cid's
-- 112 was never uploaded.
insert into claims (player_id, number, plate, photo_key)
  values ('cccccccc-0000-0000-0000-000000000003', 112, '1ABC112', 'k/cid/112');
select t_true('44 a claim with no upload is not in the queue',
  (select count(*) from v_review_queue where number = 112) = 0);

-- Reject 70 again, and everything above it should leave the queue: those
-- claims are orphaned, and no verdict on them would change anything.
select t_as('bbbbbbbb-0000-0000-0000-000000000002');
update claims set status = 'rejected'
  where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70;

select t_true('45 rejecting a claim removes the orphaned claims above it',
  (select count(*) from v_review_queue where player_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0);

select t_true('46 the rejected claim is offered for undo to its rejector',
  (select can_undo from v_rejected_claims where number = 70));

select t_as('aaaaaaaa-0000-0000-0000-000000000001');
select t_true('47 and not to anyone else',
  (select can_undo from v_rejected_claims where number = 70) = false);

-- Undoing brings them all back, unreviewed, with nothing repaired.
select t_as('bbbbbbbb-0000-0000-0000-000000000002');
update claims set status = 'pending'
  where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 70;

select t_true('48 undo returns the orphaned claims to the queue',
  (select count(*) from v_review_queue where player_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 2);


-- ============================================================================
-- The finality window  (spec §7)
--
-- Untested until now: the window could be deleted from all three places it
-- lives — the policy, the queue view and the guard — and every test still
-- passed. It bounds rejection only; approval is not destruction and is open
-- at any age.
--
-- created_at is immutable to the guard, so these fixtures are aged as
-- superuser with the guard off, which is a fixture concern and not a rule one.
-- ============================================================================

reset role;
-- Superuser again, but auth.uid() still reports whoever acted last, and the
-- players guard rightly refuses a non-admin changing seed_next. Fixtures act
-- as nobody.
select t_as(null);

insert into auth.users (id, email, raw_user_meta_data)
  values ('dddddddd-0000-0000-0000-000000000004', 'dee@example.com', '{"display_name":"Dee"}');
update players set seed_next = 200 where id = 'dddddddd-0000-0000-0000-000000000004';

insert into claims (player_id, number, plate, photo_key, uploaded_at)
  values ('dddddddd-0000-0000-0000-000000000004', 200, '1ABC200', 'k/dee/200', now());
insert into claims (player_id, number, plate, photo_key, uploaded_at)
  values ('dddddddd-0000-0000-0000-000000000004', 201, '1ABC201', 'k/dee/201', now());

alter table claims disable trigger trg_claims_before_update_guard;
update claims set created_at = now() - interval '30 days'
  where player_id = 'dddddddd-0000-0000-0000-000000000004';
alter table claims enable trigger trg_claims_before_update_guard;

select t_true('49 finality_days is read from app_config, not hard-coded',
  finality_days() = 14);

set role authed;
select t_as('bbbbbbbb-0000-0000-0000-000000000002');

-- Rejection is bounded.
select t_run('50 a claim past the window cannot be rejected',
  $q$update claims set status = 'rejected'
      where player_id = 'dddddddd-0000-0000-0000-000000000004' and number = 200$q$, true);

select t_true('50a and it is still pending',
  (select status from claims
    where player_id = 'dddddddd-0000-0000-0000-000000000004' and number = 200) = 'pending');

-- Approval is not. This is the case that made an unreviewed claim permanently
-- uncountable, since "no auto-approval" means only a human can approve it.
select t_run('51 a claim past the window can still be approved',
  $q$update claims set status = 'approved'
      where player_id = 'dddddddd-0000-0000-0000-000000000004' and number = 200$q$, false);

select t_true('51a and it counts',
  confirmed_count('dddddddd-0000-0000-0000-000000000004') = 202,
  'seed 200, plus 200 approved by hand, plus 201 auto-approved — both of Dee''s claims are past the window');

-- An old claim is still reviewable, so it stays in the queue, carrying whether
-- rejection is still open.
-- Past the window there is nothing left to decide, so it leaves the queue.
select t_true('52 an old claim is no longer in the review queue',
  (select count(*) from v_review_queue
    where player_id = 'dddddddd-0000-0000-0000-000000000004' and number = 201) = 0);

select t_true('52a it reads as auto_approved, though its status is still pending',
  (select effective_status(status, created_at) from claims
    where player_id = 'dddddddd-0000-0000-0000-000000000004' and number = 201) = 'auto_approved'
  and (select status from claims
    where player_id = 'dddddddd-0000-0000-0000-000000000004' and number = 201) = 'pending');

select t_true('52b nobody is recorded as having approved it',
  (select reviewed_by is null from claims
    where player_id = 'dddddddd-0000-0000-0000-000000000004' and number = 201),
  'auto-approval is the absence of a review, so there is no actor to record');

select t_true('52c it counts, and is not reported as awaiting review',
  confirmed_count('dddddddd-0000-0000-0000-000000000004') = 202
  and pending_count('dddddddd-0000-0000-0000-000000000004') = 0
  and auto_approved_count('dddddddd-0000-0000-0000-000000000004') = 1,
  'seed 200 + approved 200 + auto-approved 201');

select t_true('52d and it is listed as auto-approved',
  (select count(*) from v_auto_approved
    where player_id = 'dddddddd-0000-0000-0000-000000000004' and number = 201) = 1);

-- The knob is live and retroactive, which is the cost of it being reversible.
reset role;
select t_as(null);
update app_config set value = '90' where key = 'finality_days';

select t_true('52e widening the window takes an auto-approval back',
  (select effective_status(status, created_at) from claims
    where player_id = 'dddddddd-0000-0000-0000-000000000004' and number = 201) = 'pending'
  and confirmed_count('dddddddd-0000-0000-0000-000000000004') = 201,
  'the count falls again, with nothing written or undone');

update app_config set value = '14' where key = 'finality_days';
set role authed;
select t_as('bbbbbbbb-0000-0000-0000-000000000002');

select t_true('52f and narrowing it puts the auto-approval back',
  confirmed_count('dddddddd-0000-0000-0000-000000000004') = 202);

select t_true('52g a fresh claim is pending, not auto-approved',
  (select effective_status(status, created_at) from claims
    where player_id = 'aaaaaaaa-0000-0000-0000-000000000001' and number = 71) = 'pending');

-- The defect this section exists for: undo past the window restored the row
-- and then stranded it, because the re-judgement undo exists to reopen was
-- still bounded. Dee lost the find anyway.
reset role;
select t_as(null);
insert into auth.users (id, email, raw_user_meta_data)
  values ('eeeeeeee-0000-0000-0000-000000000005', 'eve@example.com', '{"display_name":"Eve"}');
insert into claims (player_id, number, plate, photo_key, uploaded_at, status, reviewed_by, reviewed_at)
  values ('eeeeeeee-0000-0000-0000-000000000005', 0, '1ABC000', 'k/eve/0', now(),
          'rejected', 'bbbbbbbb-0000-0000-0000-000000000002', now());
alter table claims disable trigger trg_claims_before_update_guard;
update claims set created_at = now() - interval '30 days'
  where player_id = 'eeeeeeee-0000-0000-0000-000000000005';
alter table claims enable trigger trg_claims_before_update_guard;

set role authed;
select t_as('bbbbbbbb-0000-0000-0000-000000000002');

select t_run('53 a rejection can be undone past the window',
  $q$update claims set status = 'pending'
      where player_id = 'eeeeeeee-0000-0000-0000-000000000005' and number = 0$q$, false);

select t_run('54 and the claim it restored can then be judged',
  $q$update claims set status = 'approved'
      where player_id = 'eeeeeeee-0000-0000-0000-000000000005' and number = 0$q$, false);

select t_true('54a so the undo actually gave the find back',
  confirmed_count('eeeeeeee-0000-0000-0000-000000000005') = 1,
  'undo restored the row but left it unjudgeable, so this stayed 0');

reset role;


-- ============================================================================
-- Re-claiming a number after a rejection
--
-- The whole point of a rejection is that the player goes back and shoots that
-- number again: one_live_claim_per_number excludes rejected rows precisely so
-- they can. Nothing tested whether the replacement then counts.
--
-- Fay: 000 approved, 001 rejected. She re-shoots 001.
-- ============================================================================

select t_as(null);
insert into auth.users (id, email, raw_user_meta_data)
  values ('ffffffff-0000-0000-0000-000000000006', 'fay@example.com', '{"display_name":"Fay"}');

set role authed;
select t_as('ffffffff-0000-0000-0000-000000000006');
insert into claims (player_id, number, plate, photo_key, uploaded_at)
  values ('ffffffff-0000-0000-0000-000000000006', 0, '1ABC000', 'k/fay/0', now());
insert into claims (player_id, number, plate, photo_key, uploaded_at)
  values ('ffffffff-0000-0000-0000-000000000006', 1, '1ABC001', 'k/fay/1', now());

select t_as('bbbbbbbb-0000-0000-0000-000000000002');
update claims set status = 'approved'
  where player_id = 'ffffffff-0000-0000-0000-000000000006' and number = 0;
update claims set status = 'rejected'
  where player_id = 'ffffffff-0000-0000-0000-000000000006' and number = 1;

select t_true('55 the rejection sends her back to that number',
  next_target('ffffffff-0000-0000-0000-000000000006') = 1);

select t_as('ffffffff-0000-0000-0000-000000000006');

select t_run('56 the rejected number can be claimed again',
  $q$insert into claims (player_id, number, plate, photo_key, uploaded_at)
     values ('ffffffff-0000-0000-0000-000000000006', 1, '2ABC001', 'k/fay/1b', now())$q$, false);

-- The replacement has to stand on its own. first_rejected_number still sees
-- the superseded row at the same number, so without that being accounted for
-- the new claim is born inactive and the player never leaves this number.
select t_true('57 the replacement claim is live',
  is_active_claim('ffffffff-0000-0000-0000-000000000006', 1,
    (select status from claims
      where player_id = 'ffffffff-0000-0000-0000-000000000006'
        and number = 1 and status <> 'rejected')),
  'the re-shot claim is inert, so the rejection is a permanent wall');

select t_true('58 and it advances the target',
  next_target('ffffffff-0000-0000-0000-000000000006') = 2,
  'target stayed on the rejected number even after it was re-claimed');

select t_as('bbbbbbbb-0000-0000-0000-000000000002');
select t_run('59 the replacement can be approved',
  $q$update claims set status = 'approved'
      where player_id = 'ffffffff-0000-0000-0000-000000000006'
        and number = 1 and status = 'pending'$q$, false);

select t_true('60 and approving it gives the find back',
  confirmed_count('ffffffff-0000-0000-0000-000000000006') = 2,
  'approved but still not counted, because it sits at the rejected number');

select t_true('61 the rejected row is kept, not overwritten',
  (select count(*) from claims
    where player_id = 'ffffffff-0000-0000-0000-000000000006'
      and number = 1 and status = 'rejected') = 1);

reset role;


-- ============================================================================
-- Blocked claims are visible to their owner  (spec §6)
--
-- Gil: 000 approved, then 001 rejected, stranding 002 and 003 above it.
-- ============================================================================

select t_as(null);
insert into auth.users (id, email, raw_user_meta_data)
  values ('11111111-0000-0000-0000-000000000007', 'gil@example.com', '{"display_name":"Gil"}');

set role authed;
select t_as('11111111-0000-0000-0000-000000000007');
insert into claims (player_id, number, plate, photo_key, uploaded_at) values
  ('11111111-0000-0000-0000-000000000007', 0, '1ABC000', 'k/gil/0', now()),
  ('11111111-0000-0000-0000-000000000007', 1, '1ABC001', 'k/gil/1', now()),
  ('11111111-0000-0000-0000-000000000007', 2, '1ABC002', 'k/gil/2', now()),
  ('11111111-0000-0000-0000-000000000007', 3, '1ABC003', 'k/gil/3', now());

select t_as('bbbbbbbb-0000-0000-0000-000000000002');
update claims set status = 'approved'
  where player_id = '11111111-0000-0000-0000-000000000007' and number = 0;
update claims set status = 'rejected'
  where player_id = '11111111-0000-0000-0000-000000000007' and number = 1;

select t_true('62 claims stranded above the rejection are listed as blocked',
  (select count(*) from v_blocked_claims
    where player_id = '11111111-0000-0000-0000-000000000007') = 2,
  'expected 002 and 003');

select t_true('63 and each names the rejection that stranded it',
  (select blocked_by from v_blocked_claims
    where player_id = '11111111-0000-0000-0000-000000000007' and number = 2) = 1);

select t_true('64 a claim that still stands is not listed',
  (select count(*) from v_blocked_claims
    where player_id = '11111111-0000-0000-0000-000000000007' and number = 0) = 0,
  'an active claim was reported as blocked');

select t_true('65 the rejection itself is not listed as blocked',
  (select count(*) from v_blocked_claims
    where player_id = '11111111-0000-0000-0000-000000000007' and number = 1) = 0);

select t_as('11111111-0000-0000-0000-000000000007');

select t_true('66 can_delete is offered on a blocked pending claim',
  (select can_delete from v_blocked_claims
    where player_id = '11111111-0000-0000-0000-000000000007' and number = 3));

-- can_delete is a claim about the policy, so check the policy agrees rather
-- than trusting the column that describes it.
select t_run('67 and the policy permits that delete',
  $q$delete from claims
      where player_id = '11111111-0000-0000-0000-000000000007' and number = 3$q$, false);

select t_true('67a the row is actually gone',
  (select count(*) from claims
    where player_id = '11111111-0000-0000-0000-000000000007' and number = 3) = 0,
  'RLS matched no rows and the delete silently did nothing');

-- Re-shooting the rejected number takes the wall down, and 002 — untouched
-- throughout — comes back on its own.
insert into claims (player_id, number, plate, photo_key, uploaded_at)
  values ('11111111-0000-0000-0000-000000000007', 1, '2ABC001', 'k/gil/1b', now());

select t_true('68 re-claiming the rejected number frees what was above it',
  (select count(*) from v_blocked_claims
    where player_id = '11111111-0000-0000-0000-000000000007') = 0,
  'the wall came down but the orphan stayed blocked');

select t_true('69 and the target moves past the claim that was stranded',
  next_target('11111111-0000-0000-0000-000000000007') = 3,
  'expected 003: 000, 001 re-claimed and 002 all stand again');

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
