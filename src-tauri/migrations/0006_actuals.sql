-- Guma: what a project actually took, against what it was quoted at.
--
-- Two holes this closes, both of the same shape as the payments one -- a
-- table or a question that existed with nothing behind it:
--
--   1. print_runs has had a units_used column since 0001 and nothing has
--      ever written to it. So materials.on_hand only ever rose (purchases
--      push it up, nothing pulls it down) and every "material at cost"
--      figure was an estimate of an estimate.
--
--   2. The design gate asks whether the hours on the quote match the hours
--      actually spent. That is the single most common place a small shop
--      loses its margin, and until now it was a question with no data
--      behind it -- a promise a tired person ticks at 7pm.
--
-- Both are answered by logging two cheap facts: a build run (this printer,
-- this material, this many grams, this many hours, did it work) and an hour
-- of work (design or finishing, on this day, by this person).
--
-- Failed runs consume material and cost machine time exactly like
-- successful ones. That is the whole point of recording them: a shop that
-- writes off two failed plates and does not count them is a shop that
-- thinks its margin is better than it is. Consumption below is therefore
-- unconditional on outcome; only the reporting separates them.

alter table print_runs add column hours numeric;
alter table print_runs add column note text;
-- Set when the run's material has been taken off the shelf, so a row is
-- never double-counted if it is edited later.
alter table print_runs add column consumed_at text;

-- Stock drawdown. Guma does not watch machines -- this fires when a human
-- records a run, not when a printer finishes one -- but a figure that moves
-- in both directions is worth having even when a person has to move it.
create trigger t_run_consume_insert after insert on print_runs
when new.material_id is not null and new.units_used is not null and new.consumed_at is null
begin
  update materials set on_hand = max(0, coalesce(on_hand, 0) - new.units_used)
   where id = new.material_id;
  update print_runs set consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = new.id;
end;

create trigger t_run_consume_delete after delete on print_runs
when old.material_id is not null and old.units_used is not null and old.consumed_at is not null
begin
  update materials set on_hand = coalesce(on_hand, 0) + old.units_used
   where id = old.material_id;
end;

-- Hours that are not machine hours. Deliberately not a timer or a
-- timesheet: a shop owner will log "3 hours, modelling the bracket" at the
-- end of a day, and will not run a stopwatch. Anything more elaborate than
-- this does not get filled in, and a log nobody fills in is worse than none
-- because it looks like evidence.
create table work_log (
  id        text primary key,
  shop_id   text not null references shops on delete cascade,
  job_id    text not null references jobs on delete cascade,
  kind      text not null check (kind in ('design','finishing','admin')),
  hours     numeric not null check (hours > 0),
  worked_on text not null default (date('now')),
  note      text,
  actor_id  text references profiles,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_work_log_job on work_log (job_id, worked_on desc);
create index idx_work_log_shop on work_log (shop_id, worked_on desc);

-- What a project actually cost, folded the same way job_money folds
-- payments: derived at read time from append-only facts, never stored.
--
-- Scalar subqueries rather than joins on purpose -- runs and work entries
-- are both one-to-many off the same row, and joining both would multiply
-- them together and need un-multiplying in TypeScript.
--
-- Material is costed at the CURRENT weighted average rather than the price
-- on the day, because the question this answers is "what did this job cost
-- me" in today's money, and because per-run cost basis would mean freezing
-- a price on every run -- more bookkeeping than a small shop will do. The
-- quote's own basis stays frozen in rates_snapshot regardless, so the
-- client-facing number never moves.
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
  -- Electricity, on the same terms pricing.ts uses: hours x kW x $/kWh.
  -- Zero when the shop has not supplied a rate or the printer has no
  -- wattage on file, which is the same "degrades to an estimate rather
  -- than blocking" rule the quote side follows.
  (select coalesce(sum(r.hours * (p.watts / 1000.0) * s.electricity_rate_kwh), 0.0)
     from print_runs r
     join printers p on p.id = r.printer_id
     join shops s on s.id = j.shop_id
    where r.job_id = j.id and p.watts is not null and s.electricity_rate_kwh is not null)
    as power_cost,
  (select count(*) from print_runs r where r.job_id = j.id) as runs,
  (select count(*) from print_runs r where r.job_id = j.id and r.outcome = 'failed') as failed_runs,
  (select coalesce(sum(w.hours), 0.0) from work_log w
    where w.job_id = j.id and w.kind = 'design') as design_hours,
  (select coalesce(sum(w.hours), 0.0) from work_log w
    where w.job_id = j.id and w.kind = 'finishing') as finishing_hours,
  (select coalesce(sum(w.hours), 0.0) from work_log w
    where w.job_id = j.id and w.kind = 'admin') as admin_hours
from jobs j;
