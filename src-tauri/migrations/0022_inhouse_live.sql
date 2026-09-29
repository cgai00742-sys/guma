-- Guma: the shop's own work was being born a draft.
--
-- A draft is "a price nobody has agreed to yet" (0008_drafts.sql): saved,
-- findable, and deliberately kept off the board until a client says yes.
-- In-house work has no price and nobody to say yes. But createInHouseJob
-- never set taken_in_at, so every in-house project ever created was a draft
-- -- off the board, off the dashboard's open count, and offering "Take it
-- into Intake" on a ladder that has no Intake stage. Reported by CG as "the
-- drafts feature isn't working" while trying to build BathyTopo.
--
-- The create path is fixed in both backends. This repairs the rows that
-- already exist, dating each one from when it was created -- which is when
-- it actually started, and the only honest date available. Client drafts
-- are untouched: for them, a null here is a real decision.
update jobs
   set taken_in_at = created_at
 where kind = 'inhouse' and taken_in_at is null;
