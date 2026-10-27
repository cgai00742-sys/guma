-- Guma: what a client has paid counts once, whatever it was recorded as.
--
-- Found 27 Oct 2026 on CG's 16" Anson project. Deposit owed only
-- subtracted payments recorded as "Deposit", so a client who paid
-- everything in one go -- recorded as "Balance" -- left the deposit
-- reading unpaid forever, and any refund (a discount given after payment,
-- say) put the deposit back as owed. Balance owed also stopped at zero, so
-- a client who paid more than the agreed price simply vanished from view.
--
-- Now: paid = every payment minus refunds; deposit owed = what is due less
-- everything paid; overpaid = paid beyond the price. Columns are appended
-- so the hosted view can be replaced in place.
drop view if exists job_money;
create view job_money as
select
  j.id as job_id, j.shop_id, j.ref, j.title, j.phase, c.name as client,
  q.total, q.deposit_due,
  coalesce(sum(case when p.kind = 'deposit' then p.amount end), 0)
    - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0) as deposit_paid,
  coalesce(sum(case when p.kind in ('balance','partial') then p.amount end), 0) as other_paid,
  max(0, q.deposit_due
    - coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
    + coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)) as deposit_owed,
  max(0, q.total
    - coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
    + coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)) as balance_owed,
  (j.phase in ('intake','design','approval')
    and q.deposit_due > coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
                        - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)) as blocking_work,
  (j.phase = 'delivered'
    and q.total > coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
                  - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)
    and julianday('now') - julianday(q.sent_at) > 30) as late,
  coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
    - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0) as paid,
  max(0, coalesce(sum(case when p.kind <> 'refund' then p.amount end), 0)
    - coalesce(sum(case when p.kind = 'refund' then p.amount end), 0)
    - coalesce(q.total, 0)) as overpaid
from jobs j
join clients c on c.id = j.client_id
left join quotes q on q.id = (
  select q2.id from quotes q2
   where q2.job_id = j.id and q2.status in ('sent','accepted')
   order by (q2.status = 'accepted') desc, q2.version desc
   limit 1)
left join payments p on p.job_id = j.id
group by j.id, j.shop_id, j.ref, j.title, j.phase, c.name, q.total, q.deposit_due;
