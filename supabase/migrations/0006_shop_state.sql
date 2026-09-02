-- Guma: mirrors 0003_shop_state.sql (SQLite) for the hosted backend.
--
-- NOT YET APPLIED to any live Supabase project, same as 0005_show_welcome.sql
-- -- written for schema parity, run only when the tax-name helper ships on
-- the hosted build too.
alter table shops add column if not exists state text;
