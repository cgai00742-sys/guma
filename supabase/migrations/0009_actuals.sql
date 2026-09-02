-- Guma: mirrors 0006_actuals.sql (SQLite) for the hosted backend.
-- NOT YET APPLIED to any live Supabase project -- schema parity only.

alter table print_runs add column if not exists hours numeric;
alter table print_runs add column if not exists note text;
alter table print_runs add column if not exists consumed_at timestamptz;

create or replace function public.run_consume() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'INSERT' then
    if new.material_id is not null and new.units_used is not null and new.consumed_at is null then
      update materials set on_hand = greatest(0, coalesce(on_hand,0) - new.units_used)
       where id = new.material_id;
      new.consumed_at := now();
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.material_id is not null and old.units_used is not null and old.consumed_at is not null then
      update materials set on_hand = coalesce(on_hand,0) + old.units_used where id = old.material_id;
    end if;
    return old;
  end if;
  return null;
end;$$;

drop trigger if exists t_run_consume_ins on print_runs;
create trigger t_run_consume_ins before insert on print_runs
  for each row execute function public.run_consume();
drop trigger if exists t_run_consume_del on print_runs;
create trigger t_run_consume_del after delete on print_runs
  for each row execute function public.run_consume();

create table if not exists work_log (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops on delete cascade,
  job_id     uuid not null references jobs on delete cascade,
  kind       text not null check (kind in ('design','finishing','admin')),
  hours      numeric not null check (hours > 0),
  worked_on  date not null default current_date,
  note       text,
  actor_id   uuid references profiles,
  created_at timestamptz not null default now()
);
create index if not exists idx_work_log_job on work_log (job_id, worked_on desc);
create index if not exists idx_work_log_shop on work_log (shop_id, worked_on desc);

alter table work_log enable row level security;
create policy work_log_shop_all on work_log for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());

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
  (select coalesce(sum(r.hours * (p.watts / 1000.0) * s.electricity_rate_kwh),0)
     from print_runs r join printers p on p.id = r.printer_id join shops s on s.id = j.shop_id
    where r.job_id = j.id and p.watts is not null and s.electricity_rate_kwh is not null) as power_cost,
  (select count(*) from print_runs r where r.job_id = j.id) as runs,
  (select count(*) from print_runs r where r.job_id = j.id and r.outcome = 'failed') as failed_runs,
  (select coalesce(sum(w.hours),0) from work_log w where w.job_id = j.id and w.kind='design') as design_hours,
  (select coalesce(sum(w.hours),0) from work_log w where w.job_id = j.id and w.kind='finishing') as finishing_hours,
  (select coalesce(sum(w.hours),0) from work_log w where w.job_id = j.id and w.kind='admin') as admin_hours
from jobs j;
