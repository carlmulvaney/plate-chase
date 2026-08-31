-- ============================================================================
-- Local test stub — emulates the parts of a Supabase project the migration
-- depends on: the `auth` schema, `auth.uid()`, and the anon/authenticated/
-- service_role roles.
--
-- ############################################################################
-- #  THIS FILE MUST NEVER LIVE IN supabase/migrations/.                      #
-- #                                                                          #
-- #  `supabase db push` applies that directory wholesale. Pushed to a live   #
-- #  project, the auth.uid() below replaces Supabase's real one with a       #
-- #  function that reads a session variable nobody sets — so it returns      #
-- #  NULL, every RLS policy silently evaluates false, and the app goes       #
-- #  blank while looking perfectly healthy.                                  #
-- ############################################################################
--
-- Apply to a scratch database only, before the migration. See the runbook at
-- the foot of test_plate_chase.sql.
-- ============================================================================

create schema if not exists auth;

-- The columns handle_new_user() reads. Not the real shape of auth.users, just
-- enough of it.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- The identity of the current request. Tests set it with
--   set local test.uid = '<uuid>';
-- and clear it with `reset test.uid` to act as nobody.
create or replace function auth.uid() returns uuid
  language sql stable
as $fn$
  select nullif(current_setting('test.uid', true), '')::uuid;
$fn$;

-- Supabase's standard roles. `authenticated` is the one the policies name.
do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;

  -- A real, non-superuser login role for exercising RLS. Testing policies as a
  -- superuser is worthless: superusers bypass every policy, so the tests would
  -- pass just as well against a schema with no policies at all.
  if not exists (select 1 from pg_roles where rolname = 'authed') then
    create role authed login inherit;
  end if;
end
$do$;

grant authenticated to authed;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;

-- Supabase grants table privileges to these roles by default; RLS is what
-- actually constrains them. Default privileges so the migration's tables,
-- created after this file runs, are covered.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
alter default privileges in schema public
  grant execute on functions to authenticated;

grant select on auth.users to authenticated;
