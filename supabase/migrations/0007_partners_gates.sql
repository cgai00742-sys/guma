-- Guma: mirrors 0004_partners_gates.sql (SQLite) for the hosted backend.
--
-- NOT YET APPLIED to any live Supabase project, same as 0005/0006 --
-- written for schema parity so the two backends never drift, and run only
-- when partners and stage gates ship on the hosted build too.

alter table clients add column if not exists kind text not null default 'other';

alter table jobs add column if not exists poc text;
alter table jobs add column if not exists window_from date;
alter table jobs add column if not exists delivery_on date;
alter table jobs add column if not exists delivery_how text;

create table if not exists job_gates (
  job_id   uuid not null references jobs on delete cascade,
  phase    text not null,
  item_key text not null,
  checked  boolean not null default false,
  note     text,
  actor_id uuid references profiles,
  at       timestamptz not null default now(),
  primary key (job_id, phase, item_key)
);
create index if not exists idx_job_gates_job on job_gates (job_id, phase);

alter table job_gates enable row level security;

-- Same shape as job_events/job_files in 0001_schema.sql: job_gates has no
-- shop_id of its own, so the policy reaches through jobs to find one.
create policy job_gates_shop_all on job_gates for all
  using (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()))
  with check (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()));
