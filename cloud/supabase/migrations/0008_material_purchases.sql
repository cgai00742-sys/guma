-- Guma: mirrors 0005_material_purchases.sql (SQLite) for the hosted backend.
--
-- NOT YET APPLIED to any live Supabase project, same as 0005-0007 -- written
-- for schema parity so the two backends never drift.
--
-- Note the one deliberate difference from the SQLite version: no `* 1.0`
-- casts. Postgres numeric is exact decimal, so 24 / 1000 is 0.024 here and 0
-- there. The cast is a SQLite necessity, not a shared idea.

create table if not exists material_purchases (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops on delete cascade,
  material_id  uuid not null references materials on delete cascade,
  purchased_on date not null default current_date,
  qty          numeric not null check (qty > 0),
  total_cost   numeric not null check (total_cost >= 0),
  supplier     text,
  note         text,
  recorded_by  uuid references profiles,
  created_at   timestamptz not null default now()
);
create index if not exists idx_material_purchases_material
  on material_purchases (material_id, purchased_on desc);
create index if not exists idx_material_purchases_shop
  on material_purchases (shop_id, purchased_on desc);

alter table material_purchases enable row level security;
create policy material_purchases_shop_all on material_purchases for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());

-- A purchase adds to what is on the shelf; deleting one takes it back off.
create or replace function public.bump_material_stock() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'INSERT' then
    update materials set on_hand = coalesce(on_hand, 0) + new.qty where id = new.material_id;
    return new;
  elsif tg_op = 'DELETE' then
    update materials set on_hand = greatest(0, coalesce(on_hand, 0) - old.qty) where id = old.material_id;
    return old;
  end if;
  return null;
end;$$;

drop trigger if exists t_purchase_stock on material_purchases;
create trigger t_purchase_stock after insert or delete on material_purchases
  for each row execute function public.bump_material_stock();

create or replace view material_costs with (security_invoker = true) as
select
  m.id                                        as material_id,
  m.shop_id,
  coalesce(sum(p.total_cost) / nullif(sum(p.qty), 0), m.cost_per_unit) as avg_cost_per_unit,
  count(p.id)::int                            as purchases,
  coalesce(sum(p.qty), 0)                     as purchased_qty,
  coalesce(sum(p.total_cost), 0)              as purchased_spend,
  max(p.purchased_on)                         as last_purchased_on,
  (array_agg(p.total_cost / p.qty order by p.purchased_on desc, p.created_at desc))[1]
                                              as last_cost_per_unit,
  case when count(p.id) > 0 then 'purchases' else 'estimate' end as basis
from materials m
left join material_purchases p on p.material_id = m.id
group by m.id, m.shop_id, m.cost_per_unit;
