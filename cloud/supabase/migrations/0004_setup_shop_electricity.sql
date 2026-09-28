-- Guma: teach setup_shop() about the two new columns from 0003.
--
-- 0003 added shops.electricity_rate_kwh and printers.watts, but setup_shop()
-- (0002) was written before either existed, so the wizard was silently
-- dropping both on the floor. This just re-creates the function to carry
-- them through — same signature, same guard, same everything else.

create or replace function setup_shop(
  p_shop        jsonb,   -- name, legal_name, address, email, phone, license_no,
                         -- currency, locale, tax_label, tax_pct,
                         -- electricity_rate_kwh,
                         -- quote_valid_days, lead_days, terms_text,
                         -- revision_policy, payment_info
  p_rates       jsonb,   -- design_hourly, finishing_hourly, rush_pct,
                         -- minimum_order, deposit_pct, deposit_when,
                         -- deposit_waive_below, material_markup,
                         -- revisions_incl, revision_hourly
  p_printer     jsonb,   -- name, model, tech, rate_hourly, wear_hourly, watts  (nullable)
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

  v_slug := regexp_replace(lower(coalesce(p_shop->>'name', 'shop')), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then v_slug := 'shop'; end if;
  if exists (select 1 from shops where slug = v_slug) then
    v_slug := v_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  insert into shops (
    name, slug, legal_name, address, email, phone, license_no,
    currency, locale, tax_label, tax_pct, electricity_rate_kwh,
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
    nullif(p_shop->>'electricity_rate_kwh', '')::numeric,
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
    insert into printers (shop_id, name, model, tech, rate_hourly, wear_hourly, watts, status)
    values (
      v_shop,
      p_printer->>'name',
      coalesce(nullif(p_printer->>'model', ''), '—'),
      coalesce(nullif(p_printer->>'tech', ''), 'fdm'),
      coalesce((p_printer->>'rate_hourly')::numeric, 0),
      coalesce((p_printer->>'wear_hourly')::numeric, 0),
      nullif(p_printer->>'watts', '')::numeric,
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
