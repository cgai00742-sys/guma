-- Guma: each copy of a part keeps its own state, in its own place.
--
-- CG, 8 Oct 2026, after 0031: "each part [needs] an optional dropdown list
-- so that each instance can be marked printed or failed", and a way to put
-- a copy marked by mistake back to neutral. Counts alone could not do that:
-- with five identical copies counted, "copy 3 failed" has no copy 3.
--
-- copy_states is a JSON array, one entry per copy, in order:
--   "pending" | "printed" | "passed" | "reprint"
-- Null means "not split out yet": the copies are read from the 0031 counts
-- (passed first, then printed, going back, not printed) and written back
-- as an array the first time any copy moves. printed_n / passed_n /
-- reprint_n and status stay, kept in step on every write, because the
-- views and the board read them.
alter table job_parts add column copy_states text;

-- Which copies an event moved, 1-based ("2" or "1,4"), so a failed copy can
-- show its own reason. Null on events that did not name copies.
alter table part_events add column copies text;
