-- The hosted twin of src-tauri/migrations/0016_quote_builds.sql.
-- Read that file for why the old single-machine columns stay in place and
-- are ignored rather than mirrored.
--
-- Written with the desktop migration and deliberately NOT applied to the
-- live hosted project: the offline edition is being proven first. It exists
-- because schemaParity.test.ts fails the build the moment a desktop column
-- has no hosted column.

create table if not exists quote_builds (
  id              uuid primary key default gen_random_uuid(),
  quote_id        uuid not null references quotes on delete cascade,
  kind            text not null default 'print' check (kind in ('print')),
  label           text not null,
  printer_id      uuid references printers,
  material_id     uuid references materials,
  qty             integer not null default 1 check (qty >= 1),
  units_per_part  numeric not null default 0,
  print_hrs_part  numeric not null default 0,
  slice_import_id uuid references slice_imports on delete set null,
  sort            integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists idx_quote_builds_quote on quote_builds (quote_id, sort, created_at);

alter table quote_builds enable row level security;
-- No shop_id of its own, so the policy reaches through quotes -- the same
-- shape job_gates, part_events and slice_sections use.
create policy quote_builds_shop_all on quote_builds for all
  using (exists (select 1 from quotes q
                  where q.id = quote_id and q.shop_id = current_shop_id()))
  with check (exists (select 1 from quotes q
                  where q.id = quote_id and q.shop_id = current_shop_id()));
