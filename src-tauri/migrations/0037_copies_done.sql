-- Guma: how many copies on a project are made, for the gates and the board.
--
-- CG, 13 Oct 2026, reviewing in-house work: a piece moved from Working to
-- Made with its only part still 0 of 1 printed -- nothing checked the build
-- sheet. "printed" in this view counts parts that have STARTED (one copy of
-- five), which is right for "the run has started" and wrong for "the
-- printing is done". copies_done is the second question: every copy off the
-- machine (printed or passed), against copies.
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
                                                                                  as reprints_ever,
  (select coalesce(sum(p.printed_n + p.passed_n), 0) from job_parts p where p.job_id = j.id)
                                                                                  as copies_done
from jobs j;
