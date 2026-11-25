-- Guma: the Print Inbox (CG, 24 Nov 2026). Twin of the desktop's 0047 --
-- see it for the reasons. Prints from Prusa Connect wait here until a
-- person approves how they came off and which project they belong to.

create table if not exists print_inbox_files (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops on delete cascade,
  file_name   text not null,
  sha1        text not null,
  payload     text not null,
  summary     text not null default '{}',
  created_at  timestamptz not null default now(),
  unique (shop_id, sha1)
);

create table if not exists print_inbox (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references shops on delete cascade,
  source_ref       text not null,
  printer_id       uuid references printers on delete set null,
  file_id          uuid references print_inbox_files on delete set null,
  file_name        text not null,
  started_at       timestamptz,
  ended_at         timestamptz,
  state            text not null check (state in ('finished', 'stopped')),
  minutes          numeric,
  facts            text not null default '{}',
  suggested_job_id uuid references jobs on delete set null,
  suggest_reason   text,
  decision         text not null default '{}',
  status           text not null default 'new' check (status in ('new', 'approved', 'ignored')),
  run_id           uuid references print_runs on delete set null,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (shop_id, source_ref)
);
create index if not exists idx_print_inbox_status on print_inbox (shop_id, status, ended_at);
create index if not exists idx_print_inbox_job on print_inbox (suggested_job_id);

alter table print_inbox_files enable row level security;
create policy print_inbox_files_shop_all on print_inbox_files for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());
alter table print_inbox enable row level security;
create policy print_inbox_shop_all on print_inbox for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());
