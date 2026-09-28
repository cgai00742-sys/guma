-- Guma: two hosted-only defects found when 0005-0017 were finally applied to
-- the live Supabase project on 27 Sept 2026. Both are hosted-side only --
-- neither can exist on the desktop, and neither was catchable by any test in
-- this repo at the time. Read that as the reason this file exists at all.

-- 1. guide_seen was created with RLS enabled and NO POLICY.
--
-- 0015_guide.sql ends at `alter table guide_seen enable row level security`.
-- On Postgres, RLS with no policy is not "open", it is DENY: every select and
-- insert from `authenticated` returns nothing and writes nothing, silently.
-- The hosted guide could never record a chapter as seen, so every chapter
-- reappeared on every visit.
--
-- Nothing local shows this. The desktop twin (0013_guide.sql) has no RLS
-- because SQLite has none, so the feature works there. schemaParity.test.ts
-- compares COLUMNS, and the columns matched perfectly -- the same blind spot
-- that let 0012_in_house.sql ship without its twin, one level further in.
-- schemaParity.test.ts now also requires a policy wherever a hosted migration
-- enables RLS.
--
-- Same shop-scoped shape as every other table here.
create policy guide_seen_shop_all on guide_seen for all
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

-- 2. Two TRIGGER functions were reachable as REST endpoints.
--
-- bump_material_stock() and run_consume() are SECURITY DEFINER, which they
-- must be -- they write to materials.on_hand on behalf of whoever inserted
-- the row. But PostgREST exposes every function in the `public` schema as
-- /rest/v1/rpc/<name>, and execute was granted to anon and authenticated by
-- default. A trigger function called directly runs outside any trigger, so
-- SECURITY DEFINER is doing nothing but handing a caller the definer's
-- rights. Nothing in the app calls either one; the trigger does.
--
-- Revoke from PUBLIC, not from anon and authenticated.
--
-- Postgres grants execute on a new function to PUBLIC by default, and anon
-- and authenticated reach it through that, holding no grant of their own.
-- `revoke execute ... from anon, authenticated` therefore removes nothing and
-- reports success -- it was tried first, on 27 Sept, and the linter still
-- flagged both functions afterwards. The ACL said so plainly: `{=X/postgres,
-- ...}`, where the empty grantee before `=X` IS public. Check proacl, not the
-- absence of an error.
--
-- Revoking does not affect the triggers. A trigger function runs as the
-- table's owner and never consults these grants.
revoke execute on function public.bump_material_stock() from public, anon, authenticated;
revoke execute on function public.run_consume() from public, anon, authenticated;
