-- Mirror of src-tauri/migrations/0031_part_copies.sql.
alter table job_parts add column if not exists printed_n integer not null default 0 check (printed_n >= 0);
alter table job_parts add column if not exists passed_n  integer not null default 0 check (passed_n >= 0);
alter table job_parts add column if not exists reprint_n integer not null default 0 check (reprint_n >= 0);

update job_parts set printed_n = qty where status = 'printed';
update job_parts set passed_n  = qty where status = 'passed';
update job_parts set reprint_n = qty where status = 'reprint';

alter table part_events add column if not exists n integer;

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
    as reprints_ever
from jobs j;
