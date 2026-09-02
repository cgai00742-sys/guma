-- Guma: partners, stage gates, and the delivery handover.
--
-- Three additions, all of them backing something a shop already does by
-- hand today:
--
--   1. clients.kind -- what sort of buyer this is. A government contract,
--      a nonprofit, and a hobby club behave differently around deposits,
--      paperwork and payment terms, and a shop wants to see the split.
--      Defaults to 'other' so every existing client stays valid; the check
--      constraint lives in TypeScript rather than here because SQLite's
--      ALTER TABLE ADD COLUMN cannot be relaxed later without a table
--      rebuild, and this vocabulary is the sort of thing that grows.
--
--   2. The delivery handover. needed_by was already the date the client
--      is holding us to; window_from gives it a start, so "sometime in the
--      last week of July" is expressible, and delivery_on/delivery_how
--      record what actually happened rather than what was promised.
--
--   3. job_gates -- which checklist items on which stage have been ticked,
--      by whom, with what note. Deliberately only the ANSWERS: the
--      questions themselves live in src/lib/gates.ts, so the checklist can
--      be reworded, reordered or extended without a schema migration and
--      without invalidating a shop's history. A row here is a fact ("this
--      was ticked, on this date, with this note"); an item that no longer
--      exists in gates.ts simply stops being asked about.

alter table clients add column kind text not null default 'other';

alter table jobs add column poc text;
alter table jobs add column window_from text;
alter table jobs add column delivery_on text;
alter table jobs add column delivery_how text;

create table job_gates (
  job_id   text not null references jobs on delete cascade,
  phase    text not null,
  item_key text not null,
  checked  integer not null default 0,
  note     text,
  actor_id text references profiles,
  at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (job_id, phase, item_key)
);
create index idx_job_gates_job on job_gates (job_id, phase);
