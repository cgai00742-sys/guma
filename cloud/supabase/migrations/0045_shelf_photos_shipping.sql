-- Mirror of src-tauri/migrations/0041_shelf_photos_shipping.sql.
alter table products add column if not exists photo text;
alter table sales add column if not exists shipping_charged numeric(12,2) not null default 0;
alter table sales add column if not exists shipping_cost numeric(12,2) not null default 0;

create or replace view batch_stock as
select
  b.id      as batch_id,
  b.shop_id,
  b.product_id,
  b.units_made,
  b.unit_cost,
  b.made_on,
  coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0) as units_sold,
  b.units_made - coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0)
            as units_left,
  coalesce((select sum(s.units * s.unit_price) from sales s where s.batch_id = b.id), 0)
            as revenue,
  coalesce((select sum(s.fee_total) from sales s where s.batch_id = b.id), 0) as fees,
  b.unit_cost * coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0)
            as cost_of_sold,
  coalesce((select sum(s.shipping_charged) from sales s where s.batch_id = b.id), 0) as shipping_charged,
  coalesce((select sum(s.shipping_cost) from sales s where s.batch_id = b.id), 0) as shipping_cost
from batches b;
alter view batch_stock set (security_invoker = true);
