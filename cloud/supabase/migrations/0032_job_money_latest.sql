-- Mirror of src-tauri/migrations/0028_job_money_latest.sql.
create or replace view job_money with (security_invoker = true) as
select
  j.id as job_id, j.shop_id, j.ref, j.title, j.phase, c.name as client,
  q.total, q.deposit_due,
  coalesce(sum(p.amount) filter (where p.kind = 'deposit'), 0)
    - coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as deposit_paid,
  coalesce(sum(p.amount) filter (where p.kind in ('balance','partial')), 0) as other_paid,
  greatest(q.deposit_due
    - coalesce(sum(p.amount) filter (where p.kind = 'deposit'), 0)
    + coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0), 0) as deposit_owed,
  greatest(q.total
    - coalesce(sum(p.amount) filter (where p.kind <> 'refund'), 0)
    + coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0), 0) as balance_owed,
  (j.phase in ('intake','design','approval')
    and q.deposit_due > coalesce(sum(p.amount) filter (where p.kind = 'deposit'), 0)
                        - coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0)) as blocking_work,
  (j.phase = 'delivered'
    and q.total > coalesce(sum(p.amount) filter (where p.kind <> 'refund'), 0)
                  - coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0)
    and current_date - q.sent_at::date > 30) as late
from jobs j
join clients c on c.id = j.client_id
left join quotes q on q.id = (
  select q2.id from quotes q2
   where q2.job_id = j.id and q2.status in ('sent','accepted')
   order by (q2.status = 'accepted') desc, q2.version desc
   limit 1)
left join payments p on p.job_id = j.id
group by j.id, j.shop_id, j.ref, j.title, j.phase, c.name, q.total, q.deposit_due, q.sent_at;
