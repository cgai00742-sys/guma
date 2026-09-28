-- Guma: close the loop between what the slicer said and what the machine did.
--
-- 0015 deliberately kept an import OUT of print_runs, because job_actuals
-- sums runs with no filter on outcome and an estimate would then land in a
-- project's actual cost before the plate had been on the bed. That rule
-- stands. What was missing was the other half: a way to say "that print
-- happened" without retyping the grams and the hours the file already
-- knew, so material comes off the shelf and the machine hours land in the
-- actuals the moment the print comes off.
--
-- One column. A run may point at the import it was confirmed from, which
-- gives three things at once:
--   1. The screen can show an import as recorded, so nobody logs it twice.
--   2. Estimate versus actual becomes a real comparison per file, not a
--      project-level average.
--   3. Deleting the import does not delete the run -- the print still
--      happened. set null, never cascade.
alter table print_runs add column slice_import_id text references slice_imports on delete set null;
create index idx_print_runs_slice on print_runs (slice_import_id);
