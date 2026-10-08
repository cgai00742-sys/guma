-- Mirror of src-tauri/migrations/0033_actuals_per_run_power.sql: power cost
-- per run on a mixed fleet. Same columns, same order, same types, so
-- create or replace is enough.
create or replace view job_actuals with (security_invoker = true) as
select
  j.id as job_id,
  j.shop_id,
  (select coalesce(sum(r.units_used),0) from print_runs r where r.job_id = j.id) as material_units,
  (select coalesce(sum(r.units_used),0) from print_runs r
    where r.job_id = j.id and r.outcome = 'failed') as failed_units,
  (select coalesce(sum(r.units_used * mc.avg_cost_per_unit),0) from print_runs r
     join material_costs mc on mc.material_id = r.material_id where r.job_id = j.id) as material_cost,
  (select coalesce(sum(r.hours),0) from print_runs r where r.job_id = j.id) as machine_hours,
  (select coalesce(sum(r.hours * p.rate_hourly),0) from print_runs r
     join printers p on p.id = r.printer_id where r.job_id = j.id) as machine_cost,
  (select coalesce(sum(r.hours * p.wear_hourly),0) from print_runs r
     join printers p on p.id = r.printer_id where r.job_id = j.id) as wear_cost,
  (select case
            when bool_or(p.watts > 0 and s.electricity_rate_kwh > 0)
            then coalesce(sum(case
                                when p.watts > 0 and s.electricity_rate_kwh > 0
                                then r.hours * (p.watts / 1000.0) * s.electricity_rate_kwh
                                else r.hours * p.rate_hourly
                              end), 0)
            else 0
          end
     from print_runs r join printers p on p.id = r.printer_id join shops s on s.id = j.shop_id
    where r.job_id = j.id) as power_cost,
  (select count(*) from print_runs r where r.job_id = j.id) as runs,
  (select count(*) from print_runs r where r.job_id = j.id and r.outcome = 'failed') as failed_runs,
  (select coalesce(sum(w.hours),0) from work_log w where w.job_id = j.id and w.kind='design') as design_hours,
  (select coalesce(sum(w.hours),0) from work_log w where w.job_id = j.id and w.kind='finishing') as finishing_hours,
  (select coalesce(sum(w.hours),0) from work_log w where w.job_id = j.id and w.kind='admin') as admin_hours
from jobs j;
