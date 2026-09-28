-- Guma: mirrors 0007_parts.sql (SQLite) for the hosted backend.
-- NOT YET APPLIED to any live Supabase project -- schema parity only.

create table if not exists job_parts (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops on delete cascade,
  job_id     uuid not null references jobs on delete cascade,
  label      text not null,
  qty        int not null default 1 check (qty >= 1),
  status     text not null default 'pending'
             check (status in ('pending','printed','passed','reprint')),
  note       text,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_job_parts_job on job_parts (job_id, sort, created_at);
alter table job_parts enable row level security;
create policy job_parts_shop_all on job_parts for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());

create table if not exists part_events (
  id          bigserial primary key,
  part_id     uuid not null references job_parts on delete cascade,
  job_id      uuid not null references jobs on delete cascade,
  kind        text not null default 'status' check (kind in ('status','note')),
  from_status text,
  to_status   text,
  note        text,
  actor_id    uuid references profiles,
  at          timestamptz not null default now()
);
create index if not exists idx_part_events_part on part_events (part_id, at desc);
create index if not exists idx_part_events_job on part_events (job_id, at desc);
alter table part_events enable row level security;
-- No shop_id of its own, so the policy reaches through jobs, same shape as
-- job_events and job_gates.
create policy part_events_shop_all on part_events for all
  using (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()))
  with check (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()));

create or replace view job_parts_summary with (security_invoker = true) as
select
  j.id as job_id,
  j.shop_id,
  (select count(*) from job_parts p where p.job_id = j.id)::int as parts,
  (select coalesce(sum(p.qty), 0) from job_parts p where p.job_id = j.id)::int as copies,
  (select count(*) from job_parts p where p.job_id = j.id
    and p.status in ('printed','passed'))::int as printed,
  (select count(*) from job_parts p where p.job_id = j.id and p.status = 'passed')::int as passed,
  (select count(*) from job_parts p where p.job_id = j.id and p.status = 'reprint')::int as reprint,
  (select count(*) from part_events e where e.job_id = j.id and e.to_status = 'reprint')::int
    as reprints_ever
from jobs j;
