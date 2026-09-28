-- Guma: a quote that spans more than one machine.
--
-- WHY.
--
-- quotes carries one printer_id and one material_id. A hull on the H2D and
-- a cap on the XL is one job at two hourly rates and two wear rates, so
-- whichever part was not on the chosen machine was priced at the other
-- machine's rate -- and nothing on screen looked wrong. At $12/h against
-- $9/h that is a quarter off the machine line.
--
-- These lines are also the natural output of a sliced-file import: the
-- slicer already knows the object, the copies, the grams, the hours and the
-- machine. Typing them again was the thing this whole run of work set out
-- to stop.
--
-- THE OLD COLUMNS ARE NOT DROPPED, AND NOT WRITTEN EITHER.
--
-- SQLite cannot drop a column cheaply and quotes has nine tables hanging
-- off it, so quantity/material_id/printer_id/units_per_part/print_hrs_part
-- stay exactly where they are. Every quote written before this migration
-- keeps its numbers and keeps pricing to the cent -- pricing.test.ts holds
-- that, and rates_snapshot means a sent quote could not move anyway.
--
-- What must NOT happen is both shapes being live at once. Two copies of one
-- fact are free to disagree, and the one that disagrees silently is the one
-- that bills a client. So the rule is: a quote with rows here is described
-- BY those rows, and the old columns on it are ignored, not mirrored.
-- pricing.ts already works this way -- see QuoteInputs.builds.
--
-- KIND, WITH ONLY ONE VALUE SO FAR.
--
-- 'print' is the only kind today. The column exists because hardware --
-- magnets, dowels, heat-set inserts -- is coming, and it differs on three
-- axes: priced per piece rather than per gram, no machine, no print hours,
-- and consumed without a print run. Adding the column now costs nothing;
-- adding it later is a migration against live quotes. printer_id and
-- material_id are nullable for the same reason, and because an imported
-- file that matched no machine is a normal state, not an error.

create table quote_builds (
  id             text primary key,
  quote_id       text not null references quotes on delete cascade,
  kind           text not null default 'print' check (kind in ('print')),
  -- What it is, in the shop's words. A sliced-file import uses the object
  -- name off the plate.
  label          text not null,
  printer_id     text references printers,
  material_id    text references materials,
  -- Copies of THIS line, not of the job. Three hulls and one cap is two
  -- rows of qty 3 and qty 1, and the quote's own `quantity` no longer
  -- multiplies anything -- multiplying the two would square the job.
  qty            integer not null default 1 check (qty >= 1),
  -- For ONE copy. Grams or millilitres, and print hours.
  units_per_part numeric not null default 0,
  print_hrs_part numeric not null default 0,
  -- Where these numbers came from, so a figure read off a slicer is not
  -- indistinguishable from one somebody typed. Null means typed by hand.
  slice_import_id text references slice_imports on delete set null,
  sort           integer not null default 0,
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_quote_builds_quote on quote_builds (quote_id, sort, created_at);
