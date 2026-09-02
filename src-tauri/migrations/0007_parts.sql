-- Guma: the build sheet.
--
-- Ported from Voltage's project_parts and part_events, whose vocabulary is
-- kept exactly: pending -> printed -> passed, with reprint as the branch
-- back. Four states, proven in a real shop, and there was no reason to
-- invent a fifth.
--
-- This is the one part of Voltage's project view Guma kept refusing to
-- build, on the grounds that a parts table with nothing behind it would be
-- forty rows of invention. What changed is that there is now something
-- behind it: 0006 records what a build actually consumed, so a part sent
-- back to reprint is not just a red dot -- it is material and machine time
-- spent twice, on a project whose margin the tool is already watching.
-- That is the whole reason a money layer wants a build sheet at all.
--
-- Deliberately NOT ported: part_slices (printer-specific sliced variants).
-- That solves "one logical part, three sliced files, pick by which machine
-- is free" -- a real problem for a farm running mixed hardware under
-- contract, and squarely in the machine-control lane Guma has said it will
-- not enter. A shop that needs it has Klipper, OctoPrint or Voltage.

create table job_parts (
  id         text primary key,
  shop_id    text not null references shops on delete cascade,
  job_id     text not null references jobs on delete cascade,
  label      text not null,
  qty        integer not null default 1 check (qty >= 1),
  status     text not null default 'pending'
             check (status in ('pending','printed','passed','reprint')),
  note       text,
  sort       integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_job_parts_job on job_parts (job_id, sort, created_at);

-- Every status change, with the reason. A part that failed QC twice for the
-- same reason is a design problem, not bad luck, and the only way anyone
-- ever notices is if the reasons were written down at the time.
create table part_events (
  id          integer primary key autoincrement,
  part_id     text not null references job_parts on delete cascade,
  job_id      text not null references jobs on delete cascade,
  kind        text not null default 'status' check (kind in ('status','note')),
  from_status text,
  to_status   text,
  note        text,
  actor_id    text references profiles,
  at          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_part_events_part on part_events (part_id, at desc);
create index idx_part_events_job on part_events (job_id, at desc);

-- Rolled up per project, so a card, a gate and a closeout sheet can all ask
-- the same question and get the same answer. Counts are of PARTS, not
-- copies: "3 of 5 passed" reads the way a person counts a shelf.
create view job_parts_summary as
select
  j.id as job_id,
  j.shop_id,
  (select count(*) from job_parts p where p.job_id = j.id)                        as parts,
  (select coalesce(sum(p.qty), 0) from job_parts p where p.job_id = j.id)         as copies,
  (select count(*) from job_parts p where p.job_id = j.id
    and p.status in ('printed','passed'))                                        as printed,
  (select count(*) from job_parts p where p.job_id = j.id and p.status = 'passed') as passed,
  (select count(*) from job_parts p where p.job_id = j.id and p.status = 'reprint') as reprint,
  -- How many times anything has been sent back, ever -- not how many are
  -- sitting in reprint right now. A part reprinted twice and then passed
  -- costs the shop twice and would otherwise leave no trace at all.
  (select count(*) from part_events e where e.job_id = j.id and e.to_status = 'reprint')
                                                                                  as reprints_ever
from jobs j;
