-- Bootstrap the Sites mini-app data plane.
--
-- Prisma owns the *tables* (via `prisma db push` per schema); this migration owns
-- the *infrastructure* Prisma can't create: a dedicated Postgres SCHEMA for the
-- mini-app plane and a low-privilege, CONNECTION-LIMITED role the app connects as
-- at runtime. Capping that role's connections is what reproduces SQLite's old
-- single-writer-per-file isolation on Postgres — a public write flood at
-- /s/<slug> queues on the role's tiny pool and can never starve the app's pool.
--
-- Kept as a Supabase migration (not a Prisma one) so `supabase db reset`
-- reproduces the schema + role. `prisma db push --schema=prisma/sites-data.prisma`
-- runs afterward AS the owner (postgres, via SITES_DATA_DIRECT_URL) and creates
-- the 10 tables here; ALTER DEFAULT PRIVILEGES grants the runtime role DML on
-- them as they are created. LOCAL password only — a real deploy injects a secret.

create schema if not exists sites_data;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'openagent_sites_rw') then
    create role openagent_sites_rw login password 'sites_local_pw'
      connection limit 5 nosuperuser nobypassrls;
  end if;
end
$$;

-- The role reads/writes but never creates schema objects (least privilege).
grant usage on schema sites_data to openagent_sites_rw;

-- Future tables/sequences created by postgres in this schema auto-grant DML.
alter default privileges in schema sites_data
  grant select, insert, update, delete on tables to openagent_sites_rw;
alter default privileges in schema sites_data
  grant usage, select on sequences to openagent_sites_rw;

-- Idempotent catch-up for any objects that already exist on re-run.
grant select, insert, update, delete on all tables in schema sites_data to openagent_sites_rw;
grant usage, select on all sequences in schema sites_data to openagent_sites_rw;
