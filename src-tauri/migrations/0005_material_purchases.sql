-- Guma: what the shop actually paid for material.
--
-- Ported from Voltage's phase 15 (material purchase log -> weighted average
-- cost), which is the right idea and solves a real problem here.
--
-- The problem: materials.cost_per_unit is a number somebody typed once
-- during setup and has not looked at since. Every margin figure in Guma --
-- the cost-to-you panel, the shop minimum, whether a job was worth taking --
-- rests on it. Filament prices move, suppliers change, a shop buys a
-- ten-spool box at a discount, and the quote goes on using last year's
-- guess. That is not a rounding error; it is the number the whole tool is
-- for.
--
-- The fix: log what was actually paid. avg cost = sum(paid) / sum(qty)
-- across every purchase of that material, which is genuine weighted-average
-- costing, not the last price and not a manual average. Until a shop logs
-- its first purchase the typed figure still stands, so nothing breaks and
-- nobody is forced to backfill history before the app is useful. The
-- material_costs view says which of the two a figure came from, so a screen
-- can be honest about it rather than presenting a guess and a measurement
-- in the same typeface.
--
-- Quantities are in the material's OWN unit (grams for filament, mL for
-- resin) rather than Voltage's kilograms, because that is the unit
-- cost_per_unit is already in and the unit the slicer reports. The purchase
-- form does the kg multiplication; the database stores one unit, not two.

create table material_purchases (
  id           text primary key,
  shop_id      text not null references shops on delete cascade,
  material_id  text not null references materials on delete cascade,
  purchased_on text not null default (date('now')),
  -- In the material's own unit (g or mL). Must be positive: a zero-quantity
  -- purchase would divide the weighted average by nothing.
  qty          numeric not null check (qty > 0),
  total_cost   numeric not null check (total_cost >= 0),
  supplier     text,
  note         text,
  recorded_by  text references profiles,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_material_purchases_material on material_purchases (material_id, purchased_on desc);
create index idx_material_purchases_shop on material_purchases (shop_id, purchased_on desc);

-- A purchase adds to what is on the shelf. Guma does not watch machines, so
-- it can never draw stock down on its own the way a tool wired into the
-- printers could -- the shop corrects the count when it next weighs a spool
-- (saveMaterial writes on_hand directly). Rising-only would be a lie, so the
-- Materials screen says plainly that this figure is a running total the shop
-- maintains, not an observation.
create trigger t_purchase_stock_insert after insert on material_purchases
begin
  update materials set on_hand = coalesce(on_hand, 0) + new.qty where id = new.material_id;
end;

create trigger t_purchase_stock_delete after delete on material_purchases
begin
  update materials set on_hand = max(0, coalesce(on_hand, 0) - old.qty) where id = old.material_id;
end;

-- Weighted average, falling back to the typed figure until purchases exist.
-- `basis` is the honesty column: 'purchases' means measured, 'estimate'
-- means someone typed it.
--
-- The `* 1.0` is load-bearing and not decoration. SQLite has no real numeric
-- type: a `numeric` column takes INTEGER affinity, so a spool logged as
-- "1000 g for 24" stores two integers, and 24 / 1000 in integer arithmetic
-- is 0 -- silently costing every gram of material at nothing. Postgres's
-- exact-decimal numeric hides this, which is why the original this was
-- ported from has no such cast. Forcing one side to REAL first is the fix.
create view material_costs as
select
  m.id                                   as material_id,
  m.shop_id,
  coalesce(sum(p.total_cost) * 1.0 / nullif(sum(p.qty), 0), m.cost_per_unit * 1.0) as avg_cost_per_unit,
  count(p.id)                            as purchases,
  coalesce(sum(p.qty), 0)                as purchased_qty,
  coalesce(sum(p.total_cost), 0)         as purchased_spend,
  max(p.purchased_on)                    as last_purchased_on,
  (select pl.total_cost * 1.0 / pl.qty
     from material_purchases pl
    where pl.material_id = m.id
    order by pl.purchased_on desc, pl.created_at desc
    limit 1)                             as last_cost_per_unit,
  case when count(p.id) > 0 then 'purchases' else 'estimate' end as basis
from materials m
left join material_purchases p on p.material_id = m.id
group by m.id, m.shop_id, m.cost_per_unit;
