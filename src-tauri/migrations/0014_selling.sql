-- The other half of the business.
--
-- Guma has only ever been able to see work somebody commissioned. A shop
-- that prints two hundred keychains and sells them at a farmers' market has
-- done real work, spent real material and taken real money, and none of it
-- existed here. That is most of what a small shop actually does.
--
-- WHY DESIGN COST IS NOT IN THE UNIT COST.
--
-- Two rules were asked for and they pull against each other. Unit cost is
-- frozen when a batch is made, because a keychain made when filament was
-- $22/kg did cost that whatever a spool costs today. And design effort
-- should spread across everything a model ever produces, because designing
-- once and printing two hundred times is one design cost, not two hundred.
--
-- Those cannot both be true of a single frozen number. Spread design across
-- "everything ever produced" and the denominator grows every time a new
-- batch is made, so last month's frozen figure becomes wrong -- which is
-- the quiet history-rewriting this project refuses everywhere else.
--
-- So they are separated. A BATCH freezes its production cost: material,
-- machine, wear and the hands-on hours that went into those units, on the
-- day they were made, never recomputed. A PRODUCT carries the design
-- investment once, and Guma reports it as a payback -- "eleven hours of
-- design, $495; recovered $310 of it so far" -- rather than smearing it
-- into a per-unit number that has to keep changing to stay honest.
--
-- That is also how the shop actually experiences it. The design was an
-- evening you spent once. It is either paid back yet or it is not.

-- A thing the shop makes more than once. Design lives here, not on a batch.
create table products (
  id           text primary key,
  shop_id      text not null references shops on delete cascade,
  name         text not null,
  -- The job the design was done on, when there was one. Keeps the hours
  -- traceable to the runs and work entries that produced them.
  design_job_id text references jobs on delete set null,
  -- Frozen when the product is created, from that job's logged design
  -- hours at the rates in force then. Null when the design was not tracked.
  design_cost  real,
  design_hours real,
  archived     integer not null default 0,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_products_shop on products (shop_id, archived);

-- A run of units, made on a day, at a cost that never moves again.
create table batches (
  id          text primary key,
  shop_id     text not null references shops on delete cascade,
  product_id  text not null references products on delete cascade,
  -- The in-house job that produced them, so the units trace back to real
  -- print runs and hours rather than to a number somebody typed.
  job_id      text references jobs on delete set null,
  units_made  integer not null check (units_made > 0),
  -- Production cost per unit: material, machine, wear, finishing. NOT
  -- design -- see the note above. Frozen at the moment of production.
  unit_cost   real not null,
  made_on     text not null,
  note        text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_batches_product on batches (product_id, made_on desc);

-- Where the shop sells, and what that place takes.
--
-- Fees are per-channel rather than per-sale because a fee somebody has to
-- remember to calculate is a fee that gets left at zero, and then the
-- profit figure is wrong in the flattering direction. Etsy's real cut is
-- not the 6.5% everyone quotes: it is 6.5% plus 3% + $0.25 processing plus
-- $0.20 to list, which is about 10% of a $50 sale.
create table channels (
  id         text primary key,
  shop_id    text not null references shops on delete cascade,
  name       text not null,
  fee_pct    real not null default 0,
  fee_flat   real not null default 0,
  archived   integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_channels_shop on channels (shop_id, archived);

-- Units leaving, at a price, through a channel, on a day.
create table sales (
  id         text primary key,
  shop_id    text not null references shops on delete cascade,
  batch_id   text not null references batches on delete cascade,
  channel_id text references channels on delete set null,
  units      integer not null check (units > 0),
  unit_price real not null,
  -- Computed from the channel when the sale is recorded, and then stored,
  -- so changing a channel's fee next year cannot rewrite what a sale
  -- actually netted. Same rule as a quote keeping its rates.
  fee_total  real not null default 0,
  sold_on    text not null,
  note       text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_sales_batch on sales (batch_id, sold_on desc);
create index idx_sales_shop on sales (shop_id, sold_on desc);

-- What is made, what has gone, and what came back -- folded at read time so
-- nothing can be stale and there is no recalculate button. Same shape as
-- job_actuals and job_money.
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
  -- Cost of what has actually SOLD, not of what was made. The rest is
  -- stock: money already spent that has not come back yet, which is the
  -- number a shop with a full shelf most needs to see.
  b.unit_cost * coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0)
                      as cost_of_sold
from batches b;
