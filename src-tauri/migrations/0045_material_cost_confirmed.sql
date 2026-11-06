-- Guma: a price you set on purpose is not a guess.
--
-- CG, 5 Nov 2026: "the warning of adding filament to PETG keeps popping up
-- because I have inputted data for that specific filament already." He
-- had -- the cost per kg, on the Materials row. Only a logged purchase
-- counted, so the price he typed in himself was called "the figure typed
-- at setup" forever.
--
-- cost_confirmed_at: when someone saved a changed price in Settings, or
-- pressed "this price is right". basis becomes 'confirmed' -- not
-- 'purchases', which still means measured from receipts.
alter table materials add column cost_confirmed_at text;

drop view if exists material_costs;
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
  case when count(p.id) > 0 then 'purchases'
       when m.cost_confirmed_at is not null then 'confirmed'
       else 'estimate' end               as basis
from materials m
left join material_purchases p on p.material_id = m.id
group by m.id, m.shop_id, m.cost_per_unit, m.cost_confirmed_at;
