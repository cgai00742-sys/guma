-- Guma: core schema, money view, and row-level security.
-- Run this first, then 0002_setup_shop.sql. No shop is seeded — the first
-- account to sign in runs the setup wizard.

create extension if not exists "pgcrypto";

create table shops (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text unique not null,
  accent       text not null default '#FF7A45',
  accent_alt   text not null default '#2FBFD6',
  logo_path    text,
  currency     char(3) not null default 'USD',
  locale       text not null default 'en-US',
  -- No jurisdiction is assumed. The wizard asks; three decimals because some
  -- places levy rates like 4.712%.
  tax_label    text not null default 'Tax',
  tax_pct      numeric(6,3) not null default 0,
  legal_name   text, address text, email text, phone text, license_no text,
  terms_text   text, revision_policy text, payment_info text,
  quote_valid_days int not null default 30,
  lead_days        int not null default 10,
  created_at   timestamptz not null default now()
);

create table profiles (
  id         uuid primary key references auth.users on delete cascade,
  shop_id    uuid not null references shops on delete cascade,
  full_name  text not null,
  initials   text,
  role       text not null default 'staff' check (role in ('owner','staff','viewer')),
  created_at timestamptz not null default now()
);
create index on profiles (shop_id);

create table rate_cards (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops on delete cascade,
  effective_from  date not null default current_date,
  design_hourly   numeric(10,2) not null,
  finishing_hourly numeric(10,2) not null,
  rush_pct        numeric(5,2) not null default 0,
  minimum_order   numeric(10,2) not null default 0,
  deposit_pct     numeric(5,2) not null default 0,
  deposit_when    text not null default 'design' check (deposit_when in ('design','print','none')),
  deposit_waive_below numeric(10,2) not null default 0,
  material_markup numeric(6,2) not null default 2.00,
  revisions_incl  int not null default 2,
  revision_hourly numeric(10,2),
  created_at      timestamptz not null default now()
);
create index on rate_cards (shop_id, effective_from desc);

create table materials (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops on delete cascade,
  name          text not null, kind text not null,
  swatch        text not null default '#6E8298',
  unit          text not null default 'g' check (unit in ('g','ml')),
  cost_per_unit numeric(10,4) not null,
  sell_override numeric(10,4),
  on_hand       numeric(12,2) not null default 0,
  reorder_at    numeric(12,2) not null default 0,
  archived      boolean not null default false
);
create index on materials (shop_id) where not archived;

create table printers (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops on delete cascade,
  name          text not null, model text not null, bay text,
  tech          text not null check (tech in ('fdm','resin','composite','sls')),
  rate_hourly   numeric(10,2) not null,
  wear_hourly   numeric(10,2) not null,
  build_x int, build_y int, build_z int,
  status        text not null default 'idle' check (status in ('printing','idle','stopped','service')),
  loaded_material uuid references materials,
  spool_remaining numeric(12,2), nozzle_temp int, bed_temp int,
  hours_to_service numeric(8,1) not null default 250,
  fault_note    text,
  updated_at    timestamptz not null default now()
);
create index on printers (shop_id, status);

create table clients (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops on delete cascade,
  name       text not null, contact text, email text, phone text,
  source     text, notes text,
  created_at timestamptz not null default now()
);
create index on clients (shop_id);

create type job_phase as enum
  ('intake','design','approval','scheduled','building','review','delivered');

create table jobs (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops on delete cascade,
  ref           text not null,
  client_id     uuid not null references clients,
  title         text not null, brief text,
  phase         job_phase not null default 'intake',
  priority      text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  asset_origin  text not null default 'model' check (asset_origin in ('model','fix','ready')),
  steward_id    uuid references profiles,
  at_risk       boolean not null default false,
  window_locked boolean not null default false,
  needed_by     date,
  progress_pct  int not null default 0 check (progress_pct between 0 and 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (shop_id, ref)
);
create index on jobs (shop_id, phase);

create table job_events (
  id bigserial primary key,
  job_id uuid not null references jobs on delete cascade,
  actor_id uuid references profiles,
  kind text not null,
  from_phase job_phase, to_phase job_phase,
  body text, at timestamptz not null default now()
);
create index on job_events (job_id, at desc);

create table job_files (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs on delete cascade,
  storage_path text not null, filename text not null, kind text not null,
  bytes bigint, uploaded_by uuid references profiles,
  uploaded_at timestamptz not null default now()
);

create table quotes (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references shops on delete cascade,
  job_id          uuid not null references jobs on delete cascade,
  version         int not null default 1,
  status          text not null default 'draft' check (status in ('draft','sent','accepted','declined','expired')),
  design_billing  text not null default 'hourly' check (design_billing in ('hourly','flat','none')),
  design_qty      numeric(10,2) not null default 0,
  revisions_incl  int not null default 2,
  quantity        int not null default 1,
  material_id     uuid references materials,
  printer_id      uuid references printers,
  units_per_part  numeric(12,2) not null default 0,
  print_hrs_part  numeric(8,2) not null default 0,
  finishing_hrs   numeric(8,2) not null default 0,
  rush            boolean not null default false,
  flat_each       numeric(10,2) not null default 0,
  discount_pct    numeric(5,2) not null default 0,
  -- The whole rate set, frozen at send. A later rate change must never move a
  -- number on a quote a client already holds.
  rates_snapshot  jsonb,
  total           numeric(12,2), deposit_due numeric(12,2),
  valid_until     date, pdf_path text,
  sent_at timestamptz, decided_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (job_id, version)
);
create index on quotes (shop_id, status);

create table print_runs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops on delete cascade,
  job_id uuid not null references jobs on delete cascade,
  printer_id uuid not null references printers,
  material_id uuid references materials,
  started_at timestamptz, ended_at timestamptz,
  units_used numeric(12,2),
  outcome text check (outcome in ('success','failed','cancelled')),
  failure_reason text, operator_id uuid references profiles
);
create index on print_runs (printer_id, started_at desc);

create table payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops on delete cascade,
  job_id uuid not null references jobs on delete cascade,
  quote_id uuid references quotes,
  kind text not null check (kind in ('deposit','balance','partial','refund')),
  amount numeric(12,2) not null,
  method text not null check (method in ('cash','transfer','check','card','other')),
  received_on date not null default current_date,
  note text, recorded_by uuid references profiles,
  created_at timestamptz not null default now()
);
create index on payments (job_id, received_on);
create index on payments (shop_id, received_on desc);

-- Money state is DERIVED. Payments are append-only facts; there is deliberately
-- no payment_status column to fall out of sync. Refunds are netted OUT of
-- amounts received rather than counted as money in.
create view job_money with (security_invoker = true) as
select
  j.id as job_id, j.shop_id, j.ref, j.title, j.phase, c.name as client,
  q.total, q.deposit_due,
  coalesce(sum(p.amount) filter (where p.kind = 'deposit'), 0)
    - coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as deposit_paid,
  coalesce(sum(p.amount) filter (where p.kind in ('balance','partial')), 0) as other_paid,
  greatest(q.deposit_due
    - coalesce(sum(p.amount) filter (where p.kind = 'deposit'), 0)
    + coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0), 0) as deposit_owed,
  greatest(q.total
    - coalesce(sum(p.amount) filter (where p.kind <> 'refund'), 0)
    + coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0), 0) as balance_owed,
  (j.phase in ('intake','design','approval')
    and q.deposit_due > coalesce(sum(p.amount) filter (where p.kind = 'deposit'), 0)
                        - coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0)) as blocking_work,
  (j.phase = 'delivered'
    and q.total > coalesce(sum(p.amount) filter (where p.kind <> 'refund'), 0)
                  - coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0)
    and current_date - q.sent_at::date > 30) as late
from jobs j
join clients c on c.id = j.client_id
left join quotes q on q.job_id = j.id and q.status in ('sent','accepted')
left join payments p on p.job_id = j.id
group by j.id, j.shop_id, j.ref, j.title, j.phase, c.name, q.total, q.deposit_due, q.sent_at;

-- ------------------------------------------------------- row-level security
create or replace function current_shop_id() returns uuid
language sql stable security definer set search_path = public as $$
  select shop_id from profiles where id = auth.uid()
$$;

create or replace function is_shop_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'owner')
$$;

do $$ declare t text; begin
  foreach t in array array['shops','profiles','rate_cards','materials','printers',
                           'clients','jobs','job_events','job_files','quotes',
                           'print_runs','payments']
  loop execute format('alter table %I enable row level security', t); end loop;
end $$;

create policy shop_read   on shops for select using (id = current_shop_id());
create policy shop_update on shops for update
  using (id = current_shop_id() and is_shop_owner()) with check (id = current_shop_id());

create policy profiles_read on profiles for select using (shop_id = current_shop_id());
create policy profiles_self_update on profiles for update
  using (id = auth.uid()) with check (id = auth.uid() and shop_id = current_shop_id());

create policy rates_read on rate_cards for select using (shop_id = current_shop_id());
create policy rates_owner_write on rate_cards for all
  using (shop_id = current_shop_id() and is_shop_owner())
  with check (shop_id = current_shop_id() and is_shop_owner());

do $$ declare t text; begin
  foreach t in array array['materials','printers','clients','jobs','quotes','print_runs','payments']
  loop
    execute format(
      'create policy %I on %I for all using (shop_id = current_shop_id())
         with check (shop_id = current_shop_id())', t || '_shop_all', t);
  end loop;
end $$;

create policy job_events_shop_all on job_events for all
  using (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()))
  with check (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()));
create policy job_files_shop_all on job_files for all
  using (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()))
  with check (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()));

alter publication supabase_realtime add table printers, jobs, print_runs;
