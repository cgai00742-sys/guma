-- Guma: the plate's progress, and which print moved which copies.
--
-- CG, 13 Oct 2026, on the in-house Working stage: the build sheet, the
-- plates and "What it took" should talk to each other. Recording a print
-- marks copies; removing that print should offer to unmark them -- which
-- needs to know which copies it marked. And a print stopped at 15 hours of
-- a 16h 26m plate should be costed from where it got to, not by a straight
-- line: the file says that, once its moves are read (lib/gcodeWalk.ts).

-- The slicer's progress marks with filament pushed and layer reached by
-- each, as JSON [[minutes, percent, grams, layer mm], ...]. A few KB. Null
-- for files imported before this, or with no G-code in them.
alter table slice_imports add column progress text;

-- The print that moved these copies -- printed when it came off, failed
-- when it did not. Kept so removing the print can put them back. Set null
-- if the print goes anyway: the history stays, the link does not.
alter table part_events add column run_id text references print_runs on delete set null;
