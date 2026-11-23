-- Guma: who a Shelf piece went to (CG, 22 Nov 2026).
--
-- "A notes section for each part where we can put a reservation for the
-- item, donation to an organization, and/or the person who bought it ...
-- we can start to build a CRM from that." Kept to the smallest thing that
-- does that:
--
--   * A sale row says what kind of leaving it was: sold, donated, or
--     reserved (held for someone, not gone yet). A reservation holds stock
--     -- it cannot be sold twice -- and becomes a sale or a donation later.
--   * It may name who: a row in clients, the same list commissioned work
--     uses, so a buyer who later commissions a project is one person with
--     one history.
--   * A person can say yes to hearing from the shop (marketing_ok). Only
--     an explicit yes, dated, is ever recorded -- that is what CAN-SPAM and
--     the TCPA expect a shop to be able to show.
--   * followed_up_on: "how are you enjoying it" was asked.
--   * external_ref, on both: room for a point-of-sale import later (Square,
--     Shopify POS) to land each sale and customer once and only once.
alter table sales add column kind text not null default 'sale'
  check (kind in ('sale', 'donation', 'reserved'));
alter table sales add column client_id text references clients on delete set null;
alter table sales add column followed_up_on text;
alter table sales add column external_ref text;
create index idx_sales_client on sales (client_id);
create unique index idx_sales_external on sales (shop_id, external_ref) where external_ref is not null;

alter table clients add column marketing_ok integer not null default 0;
alter table clients add column marketing_ok_on text;
alter table clients add column external_ref text;
create unique index idx_clients_external on clients (shop_id, external_ref) where external_ref is not null;

-- Sold now means gone: sold or donated. A reservation is still on the
-- shelf but not free to sell, so it is its own column and not in units_left.
drop view if exists batch_stock;
create view batch_stock as
select
  b.id                as batch_id,
  b.shop_id,
  b.product_id,
  b.units_made,
  b.unit_cost,
  b.made_on,
  coalesce((select sum(s.units) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0) as units_sold,
  b.units_made - coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0)
                      as units_left,
  coalesce((select sum(s.units * s.unit_price) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0.0)
                      as revenue,
  coalesce((select sum(s.fee_total) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0.0)
                      as fees,
  b.unit_cost * coalesce((select sum(s.units) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0)
                      as cost_of_sold,
  coalesce((select sum(s.shipping_charged) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0.0)
                      as shipping_charged,
  coalesce((select sum(s.shipping_cost) from sales s where s.batch_id = b.id and s.kind <> 'reserved'), 0.0)
                      as shipping_cost,
  coalesce((select sum(s.units) from sales s where s.batch_id = b.id and s.kind = 'reserved'), 0) as units_reserved,
  coalesce((select sum(s.units) from sales s where s.batch_id = b.id and s.kind = 'donation'), 0) as units_donated
from batches b;
