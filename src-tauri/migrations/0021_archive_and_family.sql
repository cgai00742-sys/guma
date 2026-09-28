-- Guma: filing finished work away, and saying which project paid for the
-- design.
--
-- ARCHIVING. Voltage's rule, kept exactly: a completed project is never
-- deleted, because it is the system of record for what the shop earned and
-- what it cost. Archiving files it OFF the working board while keeping
-- every figure it contributes -- it still counts in the dashboard, in the
-- shop's own history and in what a material cost on average. The board is a
-- list of what needs attention; a delivered project from March needs none,
-- and leaving it there is how a board stops being read.
--
-- Only a delivered project can be archived. That check is in the data layer
-- rather than here because SQLite cannot express it in a constraint without
-- a trigger, and a trigger that silently refuses is worse than a message.
--
-- THE FAMILY. Reported directly: "this project needs a way to be linked to
-- a new project that is related to the same design hours put in. For
-- example if I print multiple other files for this project, or use a
-- different set of files for this project then they need to link to this
-- one."
--
-- One nullable self-reference, not a join table. A follow-on run points at
-- the project that paid for the design, and that is the whole shape: the
-- original holds the design hours, the follow-ons hold their own print
-- time and material. Nothing is copied between them -- design hours logged
-- once stay logged once, and the family view ADDS them up rather than
-- charging them twice, which is the mistake this is here to prevent.
--
-- set null on delete: deleting the original must orphan its follow-ons,
-- not take them with it.
alter table jobs add column archived_at text;
alter table jobs add column related_to text references jobs on delete set null;
create index idx_jobs_related on jobs (related_to);
create index idx_jobs_archived on jobs (shop_id, archived_at);
