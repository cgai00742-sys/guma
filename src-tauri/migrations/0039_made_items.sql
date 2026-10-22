-- Guma: what each print made, one row per object off the plate, and where
-- it went (CG, 21 Oct 2026: "each plate imported reflect the parts on the
-- plate and if a specific part failed we can mark it ... mark the parts as
-- something made on its own that can be added to the list of items we are
-- selling and/or add individual parts to an object which is to be made").
--
-- The pattern maker inventory tools use (Katana, Craftybase): a print run is
-- a batch that produces units; each unit carries its share of the run's
-- cost; a unit is sold on its own or used in something bigger.
--
-- An assembly is that bigger thing -- "Maui display" -- with what it needs
-- listed, so it can say what is still missing. Finished, it goes to the
-- shelf as one product at the sum of its parts, or is kept.

create table assemblies (
  id         text primary key,
  shop_id    text not null references shops on delete cascade,
  job_id     text not null references jobs on delete cascade,
  name       text not null,
  -- What it needs, as JSON [{"label": "Maui BATHY 3x", "qty": 1}, ...].
  needs      text not null default '[]',
  status     text not null default 'open' check (status in ('open', 'done')),
  -- Finished onto the shelf: the batch it became. Null and done: kept.
  batch_id   text references batches on delete set null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at    text
);
create index idx_assemblies_job on assemblies (job_id, created_at);

create table made_items (
  id          text primary key,
  shop_id     text not null references shops on delete cascade,
  job_id      text not null references jobs on delete cascade,
  -- The print it came off. Removing the print removes what it made -- the
  -- app refuses while any of it is placed.
  run_id      text references print_runs on delete cascade,
  section_id  text references slice_sections on delete set null,
  label       text not null,
  -- Grams this object stands for: the file's share when it came off, what
  -- it weighed when it failed.
  grams       real,
  -- Its share of the print's cost, frozen when the print was recorded.
  unit_cost   real not null default 0 check (unit_cost >= 0),
  status      text not null default 'made'
              check (status in ('made', 'failed', 'shelved', 'assembled', 'kept')),
  assembly_id text references assemblies on delete set null,
  batch_id    text references batches on delete set null,
  note        text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  placed_at   text
);
create index idx_made_items_job on made_items (job_id, created_at);
create index idx_made_items_run on made_items (run_id);
