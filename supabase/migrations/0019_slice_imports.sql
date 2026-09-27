-- The hosted twin of src-tauri/migrations/0015_slice_imports.sql.
-- Read that file for why an imported estimate is not a print_runs row.
--
-- Written now, with the desktop migration, and deliberately NOT applied to
-- the live hosted project yet: the offline edition is being proven first.
-- It exists because schemaParity.test.ts fails the build the moment a
-- desktop column has no hosted column, which is the guard that exists
-- because 0012_in_house.sql once shipped without its twin and broke the web
-- build for everyone but the author.

create table if not exists slice_imports (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references shops on delete cascade,
  job_id         uuid not null references jobs on delete cascade,
  file_name      text not null,
  kind           text not null check (kind in ('3mf','gcode','3mf-model')),
  printer_model  text,
  printer_id     uuid references printers,
  material_text  text,
  material_id    uuid references materials,
  est_minutes    numeric,
  est_grams      numeric,
  notes          text,
  imported_at    timestamptz not null default now()
);
create index if not exists idx_slice_imports_job on slice_imports (job_id, imported_at desc);

alter table slice_imports enable row level security;
create policy slice_imports_shop_all on slice_imports for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());

create table if not exists slice_sections (
  id          uuid primary key default gen_random_uuid(),
  import_id   uuid not null references slice_imports on delete cascade,
  part_id     uuid references job_parts on delete set null,
  label       text not null,
  qty         integer not null default 1 check (qty >= 1),
  est_minutes numeric,
  est_grams   numeric,
  material    text
);
create index if not exists idx_slice_sections_import on slice_sections (import_id);
create index if not exists idx_slice_sections_part on slice_sections (part_id);

alter table slice_sections enable row level security;
-- No shop_id of its own, so the policy reaches through slice_imports --
-- the same shape job_gates and part_events use to reach through jobs.
create policy slice_sections_shop_all on slice_sections for all
  using (exists (select 1 from slice_imports i
                  where i.id = import_id and i.shop_id = current_shop_id()))
  with check (exists (select 1 from slice_imports i
                  where i.id = import_id and i.shop_id = current_shop_id()));
