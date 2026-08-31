-- Guma: local schema (SQLite).
--
-- This is the local-first translation of the four Supabase migrations in
-- supabase/migrations/. What's missing on purpose, compared to those files:
--
--   * No row-level security, no current_shop_id()/is_shop_owner(), no
--     auth.uid() anywhere. Those existed to isolate shops sharing one
--     Postgres database. A local install has exactly one shop in this
--     file, so there is nothing to isolate.
--   * No auth.users / setup_shop() RPC. There's no sign-in step locally —
--     first run just means this file doesn't exist yet, so the app runs
--     the wizard and inserts rows directly.
--   * uuid ids become app-generated TEXT (crypto.randomUUID() on the JS
--     side before insert) since SQLite has no native uuid type.
--   * jsonb becomes TEXT holding a JSON string (rates_snapshot).
--   * booleans are INTEGER 0/1, timestamps are TEXT (ISO 8601) — SQLite's
--     usual conventions.
--   * The realtime publication at the end of 0001_schema.sql is gone;
--     nothing here has a live-sync consumer yet (see Phase 4's "sync"
--     decision on the project board: one install, one computer, for now).
--
-- Money stays derived rather than stored: no payment_status column,
-- job_money is a plain view over jobs/quotes/payments exactly as before.

create table shops (
  id                   text primary key,
  name                 text not null,
  slug                 text unique not null,
  accent               text not null default '#FF7A45',
  accent_alt           text not null default '#2FBFD6',
  logo_path            text,
  currency             text not null default 'USD',
  locale               text not null default 'en-US',
  tax_label            text not null default 'Tax',
  tax_pct              numeric not null default 0,
  legal_name           text, address text, email text, phone text, license_no text,
  terms_text           text, revision_policy text, payment_info text,
  quote_valid_days     integer not null default 30,
  lead_days            integer not null default 10,
  -- Real cost-of-goods accounting (Phase 3 on the project board). Optional —
  -- absence flags a quote's margin as an estimate, it never blocks setup.
  electricity_rate_kwh numeric,
  created_at           text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Minimal, auth-free. Only exists so quotes/jobs can say who touched them
-- when a shop has more than one person entering work at the same computer.
create table profiles (
  id         text primary key,
  shop_id    text not null references shops on delete cascade,
  full_name  text not null,
  initials   text,
  role       text not null default 'staff' check (role in ('owner','staff','viewer'))
);
create index idx_profiles_shop on profiles (shop_id);

create table rate_cards (
  id                   text primary key,
  shop_id              text not null references shops on delete cascade,
  effective_from       text not null default (date('now')),
  design_hourly        numeric not null,
  finishing_hourly     numeric not null,
  rush_pct             numeric not null default 0,
  minimum_order        numeric not null default 0,
  deposit_pct          numeric not null default 0,
  deposit_when         text not null default 'design' check (deposit_when in ('design','print','none')),
  deposit_waive_below  numeric not null default 0,
  material_markup      numeric not null default 2.00,
  revisions_incl       integer not null default 2,
  revision_hourly      numeric,
  created_at           text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_rate_cards_shop on rate_cards (shop_id, effective_from desc);

create table materials (
  id            text primary key,
  shop_id       text not null references shops on delete cascade,
  name          text not null, kind text not null,
  swatch        text not null default '#6E8298',
  unit          text not null default 'g' check (unit in ('g','ml')),
  cost_per_unit numeric not null,
  sell_override numeric,
  on_hand       numeric not null default 0,
  reorder_at    numeric not null default 0,
  archived      integer not null default 0
);
create index idx_materials_shop on materials (shop_id) where archived = 0;

create table printers (
  id               text primary key,
  shop_id          text not null references shops on delete cascade,
  name             text not null, model text not null, bay text,
  tech             text not null check (tech in ('fdm','resin','composite','sls')),
  rate_hourly      numeric not null,
  wear_hourly      numeric not null,
  -- Electricity cost (Phase 3): watts feeds machine-hours x rate x $/kWh.
  watts            numeric,
  build_x integer, build_y integer, build_z integer,
  status           text not null default 'idle' check (status in ('printing','idle','stopped','service')),
  loaded_material  text references materials,
  spool_remaining  numeric, nozzle_temp integer, bed_temp integer,
  hours_to_service numeric not null default 250,
  fault_note       text,
  updated_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_printers_shop on printers (shop_id, status);

create table clients (
  id         text primary key,
  shop_id    text not null references shops on delete cascade,
  name       text not null, contact text, email text, phone text,
  source     text, notes text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_clients_shop on clients (shop_id);

create table jobs (
  id            text primary key,
  shop_id       text not null references shops on delete cascade,
  ref           text not null,
  client_id     text not null references clients,
  title         text not null, brief text,
  phase         text not null default 'intake'
                check (phase in ('intake','design','approval','scheduled','building','review','delivered')),
  priority      text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  asset_origin  text not null default 'model' check (asset_origin in ('model','fix','ready')),
  steward_id    text references profiles,
  at_risk       integer not null default 0,
  window_locked integer not null default 0,
  needed_by     text,
  progress_pct  integer not null default 0 check (progress_pct between 0 and 100),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (shop_id, ref)
);
create index idx_jobs_shop_phase on jobs (shop_id, phase);

create table job_events (
  id         integer primary key autoincrement,
  job_id     text not null references jobs on delete cascade,
  actor_id   text references profiles,
  kind       text not null,
  from_phase text, to_phase text,
  body       text, at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_job_events_job ON job_events (job_id, at desc);

create table job_files (
  id           text primary key,
  job_id       text not null references jobs on delete cascade,
  storage_path text not null, filename text not null, kind text not null,
  bytes        integer, uploaded_by text references profiles,
  uploaded_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table quotes (
  id              text primary key,
  shop_id         text not null references shops on delete cascade,
  job_id          text not null references jobs on delete cascade,
  version         integer not null default 1,
  status          text not null default 'draft' check (status in ('draft','sent','accepted','declined','expired')),
  design_billing  text not null default 'hourly' check (design_billing in ('hourly','flat','none')),
  design_qty      numeric not null default 0,
  revisions_incl  integer not null default 2,
  quantity        integer not null default 1,
  material_id     text references materials,
  printer_id      text references printers,
  units_per_part  numeric not null default 0,
  print_hrs_part  numeric not null default 0,
  finishing_hrs   numeric not null default 0,
  rush            integer not null default 0,
  flat_each       numeric not null default 0,
  discount_pct    numeric not null default 0,
  -- The whole rate set (incl. electricityRateKwh/watts), frozen at send as
  -- a JSON string. A later rate change must never move a number on a quote
  -- a client already holds.
  rates_snapshot  text,
  total           numeric, deposit_due numeric,
  valid_until     text, pdf_path text,
  sent_at text, decided_at text,
  created_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (job_id, version)
);
create index idx_quotes_shop_status on quotes (shop_id, status);

create table print_runs (
  id             text primary key,
  shop_id        text not null references shops on delete cascade,
  job_id         text not null references jobs on delete cascade,
  printer_id     text not null references printers,
  material_id    text references materials,
  started_at text, ended_at text,
  units_used     numeric,
  outcome        text check (outcome in ('success','failed','cancelled')),
  failure_reason text, operator_id text references profiles
);
create index idx_print_runs_printer on print_runs (printer_id, started_at desc);

create table payments (
  id          text primary key,
  shop_id     text not null references shops on delete cascade,
  job_id      text not null references jobs on delete cascade,
  quote_id    text references quotes,
  kind        text not null check (kind in ('deposit','balance','partial','refund')),
  amount      numeric not null,
  method      text not null check (method in ('cash','transfer','check','card','other')),
  received_on text not null default (date('now')),
  note        text, recorded_by text references profiles,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_payments_job on payments (job_id, received_on);
create index idx_payments_shop on payments (shop_id, received_on desc);

-- Money state is DERIVED, same as the Postgres version: payments are
-- append-only facts, there is no payment_status column to fall out of sync.
create view job_money as
select
  j.id as job_id, j.shop_id, j.ref, j.title, j.phase, c.name as client,
  q.total, q.deposit_due,
  coalesce(sum(case when p.kind = 'deposit' then p.amount end), 0)
    - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0) as deposit_paid,
  coalesce(sum(case when p.kind in ('balance','partial') then p.amount end), 0) as other_paid,
  max(0, q.deposit_due
    - coalesce(sum(case when p.kind = 'deposit' then p.amount end), 0)
    + coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)) as deposit_owed,
  max(0, q.total
    - coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
    + coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)) as balance_owed,
  (j.phase in ('intake','design','approval')
    and q.deposit_due > coalesce(sum(case when p.kind = 'deposit' then p.amount end), 0)
                        - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)) as blocking_work,
  (j.phase = 'delivered'
    and q.total > coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
                  - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)
    and julianday('now') - julianday(q.sent_at) > 30) as late
from jobs j
join clients c on c.id = j.client_id
left join quotes q on q.job_id = j.id and q.status in ('sent','accepted')
left join payments p on p.job_id = j.id
group by j.id, j.shop_id, j.ref, j.title, j.phase, c.name, q.total, q.deposit_due;
