-- Guma: a saved draft is not yet a project.
--
-- Intake had one way out: save, and the thing was immediately a live
-- project sitting on the pipeline board at the Intake stage. That conflates
-- two different acts. Pricing something to see what it comes to, or taking
-- a note while a client is still on the phone, is not the same as agreeing
-- to do the work -- and a board that fills up with speculative quotes stops
-- being a board.
--
-- So a job now has a moment it was taken in. Null means it is still a
-- draft: saved, findable, priced, but off the board and out of the way
-- until someone decides it is real. Voltage draws the same line between an
-- intake_submission and a project; this is the small version of it, without
-- a second table, because in a one-person shop the person writing the draft
-- and the person accepting it are the same person.
--
-- Every row that exists today was created before this distinction existed
-- and has been worked on as a real project, so it is backfilled as taken in
-- at creation. Nothing disappears from anybody's board on upgrade.

alter table jobs add column taken_in_at text;

update jobs set taken_in_at = created_at where taken_in_at is null;
