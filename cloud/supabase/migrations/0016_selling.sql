-- Guma: the other half of the business, on the hosted backend.
--
-- The mirror of the desktop's 0014_selling.sql. Read that file for the
-- reasoning -- particularly why design cost is NOT folded into the unit
-- cost, which is the one decision here somebody will want to argue with.
-- The short version: a batch freezes what its units cost to produce on the
-- day they were produced, and a product carries the design investment once
-- and reports it as a payback. Fold design into a per-unit figure and the
-- denominator grows with every new batch, so last month's frozen number
-- quietly becomes wrong.
--
-- The two backends have to stay the same shape or the web build throws the
-- first time somebody opens the Shelf -- see lib/backends.test.ts, which
-- fails the moment a function exists on one side and not the other.

-- A thing the shop makes more than once. Design lives here, not on a batch.
create table products (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops on delete cascade,
  name          text not null,
  design_job_id uuid references jobs on delete set null,
  design_cost   numeric(12,2),
  design_hours  numeric(10,2),
  archived      boolean not null default false,
  created_at    timestamptz not null default now()
);
create index on products (shop_id, archived);

-- A run of units, made on a day, at a cost that never moves again.
create table batches (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops on delete cascade,
  product_id uuid not null references products on delete cascade,
  -- Null means the units predate Guma: somebody typed what they think they
  -- cost. That is worth recording and worth labelling, and the absence of a
  -- job is how the app knows which it is looking at. No separate flag,
  -- because a second copy of one fact is free to disagree with the first.
  job_id     uuid references jobs on delete set null,
  units_made integer not null check (units_made > 0),
  unit_cost  numeric(12,4) not null,
  made_on    date not null,
  note       text,
  created_at timestamptz not null default now()
);
create index on batches (product_id, made_on desc);

-- Where the shop sells, and what that place takes.
create table channels (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops on delete cascade,
  name       text not null,
  fee_pct    numeric(5,2) not null default 0,
  fee_flat   numeric(10,2) not null default 0,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);
create index on channels (shop_id, archived);

-- Units leaving, at a price, through a channel, on a day.
create table sales (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops on delete cascade,
  batch_id   uuid not null references batches on delete cascade,
  channel_id uuid references channels on delete set null,
  units      integer not null check (units > 0),
  unit_price numeric(12,2) not null,
  -- Worked out from the channel when the sale is recorded, then stored, so
  -- changing a fee next year cannot rewrite what a sale actually netted.
  -- Same rule as a quote keeping its own rates.
  fee_total  numeric(12,2) not null default 0,
  sold_on    date not null,
  note       text,
  created_at timestamptz not null default now()
);
create index on sales (batch_id, sold_on desc);
create index on sales (shop_id, sold_on desc);

-- What is made, what has gone, and what came back -- folded at read time so
-- nothing can be stale and there is no recalculate button.
create view batch_stock as
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
  -- The cost of what SOLD, not of what was made. The rest is stock: money
  -- already spent that has not come back yet.
  b.unit_cost * coalesce((select sum(s.units) from sales s where s.batch_id = b.id), 0)
            as cost_of_sold
from batches b;

-- Same shop-scoped policy every other table here carries.
do $$ declare t text; begin
  foreach t in array array['products','batches','channels','sales']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (shop_id = current_shop_id())
         with check (shop_id = current_shop_id())', t || '_shop_all', t);
  end loop;
end $$;

-- A view inherits nothing, so it is pinned to the caller's own rights
-- rather than the definer's: batch_stock reads batches and sales, and both
-- of those are already shop-scoped above.
alter view batch_stock set (security_invoker = true);
