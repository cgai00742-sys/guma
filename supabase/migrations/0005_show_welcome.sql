-- Guma: mirrors 0002_show_welcome.sql (SQLite) for the hosted backend.
--
-- NOT YET APPLIED to any live Supabase project as of writing -- this file
-- exists so the two schemas stay translatable, per every prior migration in
-- this project. The desktop welcome dialog works today without this: on the
-- hosted build, ctx.shop.show_welcome reads back undefined (falsy) until
-- this runs, so the dialog just never shows there. Run this only when the
-- hosted app is meant to show the same first-run dialog.
alter table shops add column if not exists show_welcome boolean not null default true;
