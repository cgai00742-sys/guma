-- Guma: work with no client, on the hosted backend.
--
-- The mirror of the desktop's 0012_in_house.sql, which shipped on 20 Sept
-- WITHOUT this twin. data.supabase.ts was already writing jobs.kind and
-- looking up clients.system, so on the web build starting in-house work
-- failed at the database ("column kind does not exist"), and every job read
-- back as client work. The desktop app was never affected.
--
-- It got through because backends.test.ts compares the two backends'
-- function NAMES, and both backends had the functions. The columns
-- underneath them were the part nobody compared. schemaParity.test.ts now
-- does.
--
-- Read 0012_in_house.sql for the reasoning. The short version: client_id
-- stays NOT NULL, each shop gets exactly one hidden client flagged system,
-- in-house jobs point at it, and every client-facing query filters it out.
-- Postgres could relax the NOT NULL cheaply where SQLite cannot, but the two
-- backends must mean the same thing, so the hosted side uses the same shape.

alter table clients add column if not exists system boolean not null default false;

-- 'client'  work somebody is paying for -- every job that already exists.
-- 'inhouse' work the shop does for itself.
alter table jobs add column if not exists kind text not null default 'client'
  check (kind in ('client','inhouse'));

create index if not exists idx_jobs_shop_kind on jobs (shop_id, kind);

-- One system client per shop, enforced -- a second would split the unbilled
-- totals in half and nothing would say so.
create unique index if not exists idx_clients_system on clients (shop_id) where system;
