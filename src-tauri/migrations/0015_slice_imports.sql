-- Guma: what the slicer said, kept apart from what the machine did.
--
-- WHY THIS IS NOT A print_runs ROW.
--
-- The obvious shape for an imported file is a print_run with outcome null,
-- confirmed later. It is wrong, and job_actuals says why: every figure in
-- that view sums print_runs with no filter on outcome. material_cost,
-- machine_hours, wear_cost, power_cost -- all of them count a run the
-- moment the row exists. So an imported estimate would land in a project's
-- actual cost before the plate had been on the bed, and quoted-versus-actual
-- would be comparing a quote against a different estimate.
--
-- "Estimates are not actuals" is the rule this whole feature exists to
-- serve. A holding table is the only shape that keeps it.
--
-- WHAT AN IMPORT IS FOR.
--
-- Two things, and they are separable on purpose:
--   1. It fills in the build sheet -- one job_parts row per object on the
--      plate, with its copy count -- so nobody types the build set.
--   2. It records what the slicer predicted, per part, so that when a run
--      IS logged there is something to compare it against.
--
-- The parts are real immediately. The estimates stay estimates until a
-- print_run is logged by hand, which is the existing flow and is not
-- changed here.
--
-- WHY TWO TABLES.
--
-- A part gets re-sliced. It fails, it is fixed, the new file is imported,
-- and the shop wants both the old prediction and the new one -- "this part
-- has been sliced three times and the estimate keeps climbing" is a design
-- problem showing itself. Same rule as rate cards and batch costs:
-- versioned by insert, never edited in place. So the header is one row per
-- FILE, and slice_sections is one row per object in that file, each
-- pointing at the job_parts row it filled in.

create table slice_imports (
  id             text primary key,
  shop_id        text not null references shops on delete cascade,
  job_id         text not null references jobs on delete cascade,
  file_name      text not null,
  -- '3mf' (Bambu/Orca sliced), 'gcode' (PrusaSlicer and friends), or
  -- '3mf-model' (an unsliced 3MF: names, no numbers).
  kind           text not null check (kind in ('3mf','gcode','3mf-model')),
  -- The machine as the FILE named it, kept verbatim even when it matched
  -- nothing. "Pursa XL" silently broke variant matching in Voltage once;
  -- keeping the raw string is how that becomes findable instead of lost.
  printer_model  text,
  -- The machine it was matched to, if one matched. Null is normal and fine.
  printer_id     text references printers,
  material_text  text,
  material_id    text references materials,
  est_minutes    numeric,
  est_grams      numeric,
  notes          text,
  imported_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_slice_imports_job on slice_imports (job_id, imported_at desc);

create table slice_sections (
  id          text primary key,
  import_id   text not null references slice_imports on delete cascade,
  -- The build-sheet row this filled in. Set null rather than cascading if
  -- the part is later deleted: the prediction still happened, and losing
  -- the record of it would quietly improve the shop's history.
  part_id     text references job_parts on delete set null,
  label       text not null,
  qty         integer not null default 1 check (qty >= 1),
  est_minutes numeric,
  est_grams   numeric,
  material    text
);
create index idx_slice_sections_import on slice_sections (import_id);
create index idx_slice_sections_part on slice_sections (part_id);
