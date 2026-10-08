-- Guma: power cost per RUN, not per project.
--
-- Found in review, 8 Oct 2026: a mixed fleet. job_actuals.power_cost summed
-- electricity only over runs on printers with a wattage on file, and every
-- reader (data.local.ts's actual_cost, actuals.ts, data.supabase.ts's
-- actualCostOf) takes `power_cost > 0 ? power_cost : machine_cost`. So the
-- moment ONE run was on a metered machine, power_cost replaced machine_cost
-- wholesale and every run on a machine without wattage cost $0.
--
-- The rule, per run: what the electricity cost when the printer has watts
-- AND the shop has a $/kWh; otherwise the hourly machine rate, the same
-- conservative fallback a project with no metered runs gets.
--
-- Column names and meanings for readers are kept so nothing downstream
-- changes: power_cost is now that per-run mix whenever ANY run is metered
-- (so `power_cost > 0 ? power_cost : machine_cost` yields the right total),
-- and 0 when none is, exactly as before. machine_cost stays hours x rate
-- over every run.
drop view if exists job_actuals;
create view job_actuals as
select
  j.id      as job_id,
  j.shop_id,
  (select coalesce(sum(r.units_used), 0) from print_runs r
    where r.job_id = j.id) as material_units,
  (select coalesce(sum(r.units_used), 0) from print_runs r
    where r.job_id = j.id and r.outcome = 'failed') as failed_units,
  (select coalesce(sum(r.units_used * mc.avg_cost_per_unit), 0.0) from print_runs r
     join material_costs mc on mc.material_id = r.material_id
    where r.job_id = j.id) as material_cost,
  (select coalesce(sum(r.hours), 0.0) from print_runs r
    where r.job_id = j.id) as machine_hours,
  (select coalesce(sum(r.hours * p.rate_hourly), 0.0) from print_runs r
     join printers p on p.id = r.printer_id
    where r.job_id = j.id) as machine_cost,
  (select coalesce(sum(r.hours * p.wear_hourly), 0.0) from print_runs r
     join printers p on p.id = r.printer_id
    where r.job_id = j.id) as wear_cost,
  (select case
            when sum(case when p.watts > 0 and s.electricity_rate_kwh > 0 then 1 else 0 end) > 0
            then coalesce(sum(case
                                when p.watts > 0 and s.electricity_rate_kwh > 0
                                then r.hours * (p.watts / 1000.0) * s.electricity_rate_kwh
                                else r.hours * p.rate_hourly
                              end), 0.0)
            else 0.0
          end
     from print_runs r
     join printers p on p.id = r.printer_id
     join shops s on s.id = j.shop_id
    where r.job_id = j.id) as power_cost,
  (select count(*) from print_runs r where r.job_id = j.id) as runs,
  (select count(*) from print_runs r where r.job_id = j.id and r.outcome = 'failed') as failed_runs,
  (select coalesce(sum(w.hours), 0.0) from work_log w
    where w.job_id = j.id and w.kind = 'design') as design_hours,
  (select coalesce(sum(w.hours), 0.0) from work_log w
    where w.job_id = j.id and w.kind = 'finishing') as finishing_hours,
  (select coalesce(sum(w.hours), 0.0) from work_log w
    where w.job_id = j.id and w.kind = 'admin') as admin_hours
from jobs j;
