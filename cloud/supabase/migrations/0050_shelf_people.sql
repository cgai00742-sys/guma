-- Mirror of src-tauri/migrations/0046_shelf_people.sql: who a Shelf piece
-- went to -- sold, donated or reserved -- and room for a POS import.
alter table sales add column if not exists kind text not null default 'sale'
  check (kind in ('sale', 'donation', 'reserved'));
alter table sales add column if not exists client_id uuid references clients on delete set null;
alter table sales add column if not exists followed_up_on date;
alter table sales add column if not exists external_ref text;
create index if not exists idx_sales_client on sales (client_id);
create unique index if not exists idx_sales_external on sales (shop_id, external_ref) where external_ref is not null;

alter table clients add column if not exists marketing_ok boolean not null default false;
alter table clients add column if not exists marketing_ok_on date;
alter table clients add column if not exists external_ref text;
create unique index if not exists idx_clients_external on clients (shop_id, external_ref) where external_ref is not null;

create or replace view batch_stock as
select
  b.id      as batch_id,
  b.shop_id,
  b.product_id,
  b.units_made,
  b.unit_cost,
  b.made_on,
  coalesce((select sum(s.units) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0) as units_sold,
  b.units_made - coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0)
            as units_left,
  coalesce((select sum(s.units * s.unit_price) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0)
            as revenue,
  coalesce((select sum(s.fee_total) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0) as fees,
  b.unit_cost * coalesce((select sum(s.units) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0)
            as cost_of_sold,
  coalesce((select sum(s.shipping_charged) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0) as shipping_charged,
  coalesce((select sum(s.shipping_cost) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0) as shipping_cost,
  coalesce((select sum(s.units) from sales s where s.batch_id = b.id and s.kind = 'reserved'), 0) as units_reserved,
  coalesce((select sum(s.units) from sales s where s.batch_id = b.id and s.kind = 'donation'), 0) as units_donated
from batches b;
alter view batch_stock set (security_invoker = true);
