-- Guma: first-run setup.
--
-- A fresh install has no shop, so the first person to sign in has no profile
-- and RLS correctly denies them everything. That is a chicken-and-egg problem,
-- and this function is the only way out of it: a SECURITY DEFINER path that
-- creates the shop, makes the caller its owner, and lays down the first rate
-- card, printer and materials in one transaction.
--
-- It refuses to run for anyone who already has a profile, so it cannot be used
-- to spawn extra shops from inside a running install.

alter table shops add column if not exists locale text not null default 'en-US';

create or replace function setup_shop(
  p_shop        jsonb,   -- name, legal_name, address, email, phone, license_no,
                         -- currency, locale, tax_label, tax_pct,
                         -- quote_valid_days, lead_days, terms_text,
                         -- revision_policy, payment_info
  p_rates       jsonb,   -- design_hourly, finishing_hourly, rush_pct,
                         -- minimum_order, deposit_pct, deposit_when,
                         -- deposit_waive_below, material_markup,
                         -- revisions_incl, revision_hourly
  p_printer     jsonb,   -- name, model, tech, rate_hourly, wear_hourly  (nullable)
  p_materials   jsonb,   -- [{name, kind, swatch, unit, cost_per_unit}]   (nullable)
  p_full_name   text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_uid  uuid := auth.uid();
  v_slug text;
  m      jsonb;
begin
  if v_uid is null then
    raise exception 'setup_shop must be called by a signed-in user';
  end if;

  if exists (select 1 from profiles where id = v_uid) then
    raise exception 'this account already belongs to a shop';
  end if;

  -- slug from the name, de-duplicated
  v_slug := regexp_replace(lower(coalesce(p_shop->>'name', 'shop')), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then v_slug := 'shop'; end if;
  if exists (select 1 from shops where slug = v_slug) then
    v_slug := v_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  insert into shops (
    name, slug, legal_name, address, email, phone, license_no,
    currency, locale, tax_label, tax_pct,
    quote_valid_days, lead_days, terms_text, revision_policy, payment_info
  ) values (
    coalesce(nullif(p_shop->>'name', ''), 'My shop'),
    v_slug,
    nullif(p_shop->>'legal_name', ''),
    nullif(p_shop->>'address', ''),
    nullif(p_shop->>'email', ''),
    nullif(p_shop->>'phone', ''),
    nullif(p_shop->>'license_no', ''),
    coalesce(nullif(p_shop->>'currency', ''), 'USD'),
    coalesce(nullif(p_shop->>'locale', ''), 'en-US'),
    coalesce(nullif(p_shop->>'tax_label', ''), 'Tax'),
    coalesce((p_shop->>'tax_pct')::numeric, 0),
    coalesce((p_shop->>'quote_valid_days')::int, 30),
    coalesce((p_shop->>'lead_days')::int, 10),
    nullif(p_shop->>'terms_text', ''),
    nullif(p_shop->>'revision_policy', ''),
    nullif(p_shop->>'payment_info', '')
  ) returning id into v_shop;

  insert into profiles (id, shop_id, full_name, initials, role)
  values (
    v_uid, v_shop,
    coalesce(nullif(p_full_name, ''), 'Owner'),
    upper(left(coalesce(nullif(p_full_name, ''), 'OW'), 2)),
    'owner'
  );

  insert into rate_cards (
    shop_id, design_hourly, finishing_hourly, rush_pct, minimum_order,
    deposit_pct, deposit_when, deposit_waive_below, material_markup,
    revisions_incl, revision_hourly
  ) values (
    v_shop,
    coalesce((p_rates->>'design_hourly')::numeric, 0),
    coalesce((p_rates->>'finishing_hourly')::numeric, 0),
    coalesce((p_rates->>'rush_pct')::numeric, 0),
    coalesce((p_rates->>'minimum_order')::numeric, 0),
    coalesce((p_rates->>'deposit_pct')::numeric, 0),
    coalesce(nullif(p_rates->>'deposit_when', ''), 'design'),
    coalesce((p_rates->>'deposit_waive_below')::numeric, 0),
    coalesce((p_rates->>'material_markup')::numeric, 2),
    coalesce((p_rates->>'revisions_incl')::int, 2),
    nullif(p_rates->>'revision_hourly', '')::numeric
  );

  if p_printer is not null and coalesce(p_printer->>'name', '') <> '' then
    insert into printers (shop_id, name, model, tech, rate_hourly, wear_hourly, status)
    values (
      v_shop,
      p_printer->>'name',
      coalesce(nullif(p_printer->>'model', ''), '—'),
      coalesce(nullif(p_printer->>'tech', ''), 'fdm'),
      coalesce((p_printer->>'rate_hourly')::numeric, 0),
      coalesce((p_printer->>'wear_hourly')::numeric, 0),
      'idle'
    );
  end if;

  if p_materials is not null then
    for m in select * from jsonb_array_elements(p_materials) loop
      if coalesce(m->>'name', '') <> '' then
        insert into materials (shop_id, name, kind, swatch, unit, cost_per_unit)
        values (
          v_shop,
          m->>'name',
          coalesce(nullif(m->>'kind', ''), m->>'name'),
          coalesce(nullif(m->>'swatch', ''), '#6E8298'),
          coalesce(nullif(m->>'unit', ''), 'g'),
          coalesce((m->>'cost_per_unit')::numeric, 0)
        );
      end if;
    end loop;
  end if;

  return v_shop;
end $$;

revoke all on function setup_shop(jsonb, jsonb, jsonb, jsonb, text) from public;
grant execute on function setup_shop(jsonb, jsonb, jsonb, jsonb, text) to authenticated;

-- The old trigger silently joined every new sign-up to whichever shop happened
-- to be first. That was right for a single seeded install and wrong for a
-- product: a fresh install has no shop to join, and an existing install should
-- not absorb strangers. New accounts now land on the setup wizard instead, and
-- an invite flow is the piece still to build.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists handle_new_user();
