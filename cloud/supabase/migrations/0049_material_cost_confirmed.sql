-- Mirror of src-tauri/migrations/0045_material_cost_confirmed.sql.
alter table materials add column if not exists cost_confirmed_at timestamptz;

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
  case when count(p.id) > 0 then 'purchases'
       when m.cost_confirmed_at is not null then 'confirmed'
       else 'estimate' end                    as basis
from materials m
left join material_purchases p on p.material_id = m.id
group by m.id, m.shop_id, m.cost_per_unit, m.cost_confirmed_at;
