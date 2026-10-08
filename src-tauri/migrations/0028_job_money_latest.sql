-- Guma: money reads ONE quote per project -- the one that counts.
--
-- Found 8 Oct 2026 from CG's "Save revision as PDF opened a blank screen".
-- A quote revision is a second quotes row for the same job. job_money
-- joined every sent or accepted version, so a revised project produced one
-- money row per version -- and every list that joined job_money (the board,
-- the project page) got one row per version too, picking whichever came
-- first. The project page then opened the OLD version's printable.
--
-- The quote that counts: the newest ACCEPTED version, because that is what
-- the client agreed to pay; failing that, the newest SENT one. A newer
-- revision that has only been sent does not move what is owed until the
-- client accepts it.
drop view if exists job_money;
create view job_money as
select
  j.id as job_id, j.shop_id, j.ref, j.title, j.phase, c.name as client,
  q.total, q.deposit_due,
  coalesce(sum(case when p.kind = 'deposit' then p.amount end), 0)
    - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0) as deposit_paid,
  coalesce(sum(case when p.kind in ('balance','partial') then p.amount end), 0) as other_paid,
  max(0, q.deposit_due
    - coalesce(sum(case when p.kind = 'deposit' then p.amount end), 0)
    + coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)) as deposit_owed,
  max(0, q.total
    - coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
    + coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)) as balance_owed,
  (j.phase in ('intake','design','approval')
    and q.deposit_due > coalesce(sum(case when p.kind = 'deposit' then p.amount end), 0)
                        - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)) as blocking_work,
  (j.phase = 'delivered'
    and q.total > coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
                  - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)
    and julianday('now') - julianday(q.sent_at) > 30) as late
from jobs j
join clients c on c.id = j.client_id
left join quotes q on q.id = (
  select q2.id from quotes q2
   where q2.job_id = j.id and q2.status in ('sent','accepted')
   order by (q2.status = 'accepted') desc, q2.version desc
   limit 1)
left join payments p on p.job_id = j.id
group by j.id, j.shop_id, j.ref, j.title, j.phase, c.name, q.total, q.deposit_due;
