-- Mirror of src-tauri/migrations/0039_made_items.sql: what each print made,
-- one row per object off the plate, and the assemblies they go into.
create table if not exists assemblies (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops on delete cascade,
  job_id     uuid not null references jobs on delete cascade,
  name       text not null,
  needs      text not null default '[]',
  status     text not null default 'open' check (status in ('open', 'done')),
  batch_id   uuid references batches on delete set null,
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
create index if not exists idx_assemblies_job on assemblies (job_id, created_at);

create table if not exists made_items (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops on delete cascade,
  job_id      uuid not null references jobs on delete cascade,
  run_id      uuid references print_runs on delete cascade,
  section_id  uuid references slice_sections on delete set null,
  label       text not null,
  grams       numeric,
  unit_cost   numeric(12,4) not null default 0 check (unit_cost >= 0),
  status      text not null default 'made'
              check (status in ('made', 'failed', 'shelved', 'assembled', 'kept')),
  assembly_id uuid references assemblies on delete set null,
  batch_id    uuid references batches on delete set null,
  note        text,
  created_at  timestamptz not null default now(),
  placed_at   timestamptz
);
create index if not exists idx_made_items_job on made_items (job_id, created_at);
create index if not exists idx_made_items_run on made_items (run_id);

alter table assemblies enable row level security;
create policy assemblies_shop_all on assemblies for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());
alter table made_items enable row level security;
create policy made_items_shop_all on made_items for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());
