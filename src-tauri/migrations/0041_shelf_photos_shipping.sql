-- Guma: a picture for each product, and shipping on each sale (CG, 22 Oct:
-- "On the Shelf ... adding pictures and a place to apply shipping costs").
--
-- Shipping is two figures, because a marketplace sale has both: what the
-- buyer paid for shipping (it comes in, like the price) and what the label
-- cost you (it goes out, like a fee). Stored with the sale, like fee_total,
-- so nothing later rewrites what a sale netted.
alter table products add column photo text;
alter table sales add column shipping_charged real not null default 0;
alter table sales add column shipping_cost real not null default 0;

drop view if exists batch_stock;
create view batch_stock as
select
  b.id                as batch_id,
  b.shop_id,
  b.product_id,
  b.units_made,
  b.unit_cost,
  b.made_on,
  coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0) as units_sold,
  b.units_made - coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0)
                      as units_left,
  coalesce((select sum(s.units * s.unit_price) from sales s where s.batch_id = b.id), 0.0)
                      as revenue,
  coalesce((select sum(s.fee_total) from sales s where s.batch_id = b.id), 0.0)
                      as fees,
  b.unit_cost * coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0)
                      as cost_of_sold,
  coalesce((select sum(s.shipping_charged) from sales s where s.batch_id = b.id), 0.0)
                      as shipping_charged,
  coalesce((select sum(s.shipping_cost) from sales s where s.batch_id = b.id), 0.0)
                      as shipping_cost
from batches b;
