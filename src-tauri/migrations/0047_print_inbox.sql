-- Guma: the Print Inbox (CG, 24 Nov 2026).
--
-- "Download all the files into a holding area ... the user has the final
-- say on if it was printed successfully, failed, needs a reprint, is in the
-- correct project." Syncing RS850 straight onto the project made the
-- judgments (how it came off, which project, where the pieces went) at the
-- moment the facts were gathered; a quality failure found a day later then
-- could not be recorded, and its reprint could not be linked.
--
-- So a print from Connect lands here first, and nothing reaches a
-- project's books until a person approves it. Facts (what Connect says)
-- and the decision (what the shop says) are kept apart: the facts never
-- change; the decision can, until it is approved. Approving applies prints
-- oldest first, so a failure queues its reprint before the reprint arrives.

-- The plate file, read once and kept, ready to put on whichever project
-- the print turns out to belong to. The same file printed twice is one row.
create table print_inbox_files (
  id          text primary key,
  shop_id     text not null references shops on delete cascade,
  file_name   text not null,
  -- sha-1 of the file's bytes: the same file is the same row.
  sha1        text not null,
  -- The import, ready to run: SliceImportInput as JSON, file included.
  payload     text not null,
  -- What the screen shows without unpacking the file: the objects and the
  -- slicer's estimate, as JSON.
  summary     text not null default '{}',
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (shop_id, sha1)
);

create table print_inbox (
  id              text primary key,
  shop_id         text not null references shops on delete cascade,
  -- Where it came from and its id there: "connect:<printer uuid>:164".
  -- Adding the same print twice finds the first (no double counting).
  source_ref      text not null,
  printer_id      text references printers on delete set null,
  file_id         text references print_inbox_files on delete set null,
  file_name       text not null,
  started_at      text,
  ended_at        text,
  -- What the printer said: finished, or stopped part way.
  state           text not null check (state in ('finished', 'stopped')),
  minutes         real,
  -- More of what Connect said, as JSON: {"job": 164, "cancelled": [...],
  -- "spools": [{"name": "CHERRYW", "material": "PLA", "grams": 35.6}]}.
  facts           text not null default '{}',
  -- Guma's guess at the project, and why ("this file is on RS850").
  suggested_job_id text references jobs on delete set null,
  suggest_reason  text,
  -- The shop's decision, as JSON (see InboxDecision). Editable until approved.
  decision        text not null default '{}',
  status          text not null default 'new' check (status in ('new', 'approved', 'ignored')),
  -- The print it became, once approved.
  run_id          text references print_runs on delete set null,
  decided_at      text,
  created_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (shop_id, source_ref)
);
create index idx_print_inbox_status on print_inbox (shop_id, status, ended_at);
create index idx_print_inbox_job on print_inbox (suggested_job_id);
