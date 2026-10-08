-- Guma: where each COPY of a part has got to.
--
-- CG, 8 Oct 2026: a part needs five, one came off as a test plate -- and
-- the build sheet could only say the whole part was printed or not. Voltage
-- solved this by splitting every copy into its own part row (copy_group /
-- copy_index, set_part_copies); thirteen parts at x5 is sixty-five rows. The
-- copies of one part are identical, so Guma keeps one row and counts where
-- they are instead: every copy is in exactly one place --
--   not printed = qty - printed_n - passed_n - reprint_n
--   printed_n   off the machine, not checked
--   passed_n    passed QC
--   reprint_n   failed, going back on a machine
-- `status` stays, as a summary the rest of the app already reads, and is
-- kept in step by the data layer on every move:
--   any copy going back -> reprint; every copy passed -> passed;
--   every copy off the machine -> printed; otherwise -> pending.
alter table job_parts add column printed_n integer not null default 0 check (printed_n >= 0);
alter table job_parts add column passed_n  integer not null default 0 check (passed_n >= 0);
alter table job_parts add column reprint_n integer not null default 0 check (reprint_n >= 0);

-- Every existing part had all its copies in one place.
update job_parts set printed_n = qty where status = 'printed';
update job_parts set passed_n  = qty where status = 'passed';
update job_parts set reprint_n = qty where status = 'reprint';

-- How many copies an event moved. Null on events from before copies were
-- counted, which moved all of them.
alter table part_events add column n integer;

-- "printed" now means a part has STARTED coming off the machine -- one copy
-- of five is a started part. The other counts read the summary status.
drop view if exists job_parts_summary;
create view job_parts_summary as
select
  j.id as job_id,
  j.shop_id,
  (select count(*) from job_parts p where p.job_id = j.id)                        as parts,
  (select coalesce(sum(p.qty), 0) from job_parts p where p.job_id = j.id)         as copies,
  (select count(*) from job_parts p where p.job_id = j.id
    and (p.printed_n + p.passed_n) > 0)                                           as printed,
  (select count(*) from job_parts p where p.job_id = j.id and p.status = 'passed') as passed,
  (select count(*) from job_parts p where p.job_id = j.id and p.status = 'reprint') as reprint,
  (select count(*) from part_events e where e.job_id = j.id and e.to_status = 'reprint')
                                                                                  as reprints_ever
from jobs j;
