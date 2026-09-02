-- Guma: mirrors 0008_drafts.sql (SQLite) for the hosted backend.
-- NOT YET APPLIED to any live Supabase project -- schema parity only.
alter table jobs add column if not exists taken_in_at timestamptz;
update jobs set taken_in_at = created_at where taken_in_at is null;
