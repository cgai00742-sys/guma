-- Mirror of src-tauri/migrations/0037_copies_done.sql. A new column goes on
-- the end, so the view can be replaced in place.
create or replace view job_parts_summary with (security_invoker = true) as
select
  j.id as job_id,
  j.shop_id,
  (select count(*) from job_parts p where p.job_id = j.id)::int as parts,
  (select coalesce(sum(p.qty), 0) from job_parts p where p.job_id = j.id)::int as copies,
  (select count(*) from job_parts p where p.job_id = j.id
    and (p.printed_n + p.passed_n) > 0)::int as printed,
  (select count(*) from job_parts p where p.job_id = j.id and p.status = 'passed')::int as passed,
  (select count(*) from job_parts p where p.job_id = j.id and p.status = 'reprint')::int as reprint,
  (select count(*) from part_events e where e.job_id = j.id and e.to_status = 'reprint')::int
    as reprints_ever,
  (select coalesce(sum(p.printed_n + p.passed_n), 0) from job_parts p where p.job_id = j.id)::int
    as copies_done
from jobs j;
