-- Guma: equipment that is not a printer, and hardware counted per piece
-- (CG, 27 Oct: "a filament dryer which I use to get the filament dialed
-- while printing ... I am adding magnets to the BathyTopo models").
--
-- EQUIPMENT asks how it is tracked, because a dryer does not sit with print
-- hours: 'hours' -- logged on a project as it is used; 'printers' -- rides
-- along with the print hours of the printers it serves; 'overhead' -- owned,
-- never on a project. Cost per hour is power (average watts at the shop's
-- $/kWh) plus wear (price over expected life), the printers' own rule.
--
-- HARDWARE is a custom piece: a name, how many, a cost per unit, a markup.
-- It is used three ways: a part's per-copy count (client work), counted for
-- every copy that has come off -- so a failed copy's pieces are back on the
-- shelf without anyone undoing anything; an assembly's per-unit count
-- (in-house), written when the assembly is finished and carried into the
-- Shelf unit cost; and pieces logged on a project by hand. stock_base is
-- what was on hand plus what had been used when the count was last set, so
-- "available" is stock_base less everything used, and setting the count
-- later is never off by history.
create table equipment (
  id          text primary key,
  shop_id     text not null references shops on delete cascade,
  name        text not null,
  kind        text not null default 'other'
              check (kind in ('dryer','wash_cure','fume','enclosure','iron','heat_gun','dehumidifier','other')),
  tracking    text not null check (tracking in ('hours','printers','overhead')),
  watts       real check (watts is null or watts >= 0),
  price       real check (price is null or price >= 0),
  life_hours  real check (life_hours is null or life_hours > 0),
  archived    integer not null default 0,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_equipment_shop on equipment (shop_id);

create table equipment_printers (
  equipment_id text not null references equipment on delete cascade,
  printer_id   text not null references printers on delete cascade,
  primary key (equipment_id, printer_id)
);

create table equipment_use (
  id           text primary key,
  shop_id      text not null references shops on delete cascade,
  job_id       text not null references jobs on delete cascade,
  equipment_id text not null references equipment on delete cascade,
  hours        real not null check (hours > 0),
  used_on      text,
  note         text,
  actor_id     text,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_equipment_use_job on equipment_use (job_id);

create table hardware_items (
  id          text primary key,
  shop_id     text not null references shops on delete cascade,
  name        text not null,
  unit_cost   real not null default 0 check (unit_cost >= 0),
  markup_pct  real not null default 0 check (markup_pct >= 0),
  stock_base  real not null default 0,
  reorder_at  real not null default 0 check (reorder_at >= 0),
  archived    integer not null default 0,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_hardware_shop on hardware_items (shop_id);

create table part_hardware (
  part_id   text not null references job_parts on delete cascade,
  item_id   text not null references hardware_items on delete cascade,
  per_copy  real not null check (per_copy > 0),
  primary key (part_id, item_id)
);

create table assembly_hardware (
  assembly_id text not null references assemblies on delete cascade,
  item_id     text not null references hardware_items on delete cascade,
  per_unit    real not null check (per_unit > 0),
  primary key (assembly_id, item_id)
);

create table hardware_use (
  id          text primary key,
  shop_id     text not null references shops on delete cascade,
  job_id      text not null references jobs on delete cascade,
  item_id     text not null references hardware_items on delete cascade,
  qty         real not null check (qty > 0),
  unit_cost   real not null check (unit_cost >= 0),
  source      text not null default 'manual' check (source in ('manual','assembly')),
  assembly_id text references assemblies on delete set null,
  note        text,
  actor_id    text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_hardware_use_job on hardware_use (job_id);
create index idx_hardware_use_item on hardware_use (item_id);

-- What each piece has had used: logged and assembly rows, plus every part's
-- per-copy count over the copies that have come off.
create view hardware_stock as
select
  i.id as item_id,
  i.shop_id,
  coalesce((select sum(h.qty) from hardware_use h where h.item_id = i.id), 0)
  + coalesce((select sum(ph.per_copy * (p.printed_n + p.passed_n + p.spare_n))
                from part_hardware ph join job_parts p on p.id = ph.part_id
               where ph.item_id = i.id), 0) as used
from hardware_items i;

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
    where w.job_id = j.id and w.kind = 'admin') as admin_hours,
  -- Equipment that is not a printer (0043). Logged hours: power at the
  -- shop's $/kWh plus wear (price over expected life). Riding along: the
  -- same, for every print hour of a printer it serves.
  (select coalesce(sum(u.hours), 0.0) from equipment_use u where u.job_id = j.id) as equipment_hours,
  (select coalesce(sum(u.hours * (coalesce(e.watts, 0) / 1000.0 * coalesce(s.electricity_rate_kwh, 0)
                                  + case when e.life_hours > 0 then coalesce(e.price, 0) / e.life_hours else 0 end)), 0.0)
     from equipment_use u join equipment e on e.id = u.equipment_id join shops s on s.id = j.shop_id
    where u.job_id = j.id)
  + (select coalesce(sum(r.hours * (coalesce(e.watts, 0) / 1000.0 * coalesce(s.electricity_rate_kwh, 0)
                                  + case when e.life_hours > 0 then coalesce(e.price, 0) / e.life_hours else 0 end)), 0.0)
     from print_runs r
     join equipment_printers ep on ep.printer_id = r.printer_id
     join equipment e on e.id = ep.equipment_id and e.tracking = 'printers'
     join shops s on s.id = j.shop_id
    where r.job_id = j.id) as equipment_cost,
  -- Hardware (0043): logged and assembly rows at the cost frozen on them,
  -- and each part's per-copy pieces for every copy that has come off.
  (select coalesce(sum(h.qty * h.unit_cost), 0.0) from hardware_use h where h.job_id = j.id)
  + (select coalesce(sum(ph.per_copy * (p.printed_n + p.passed_n + p.spare_n) * i.unit_cost), 0.0)
     from part_hardware ph join job_parts p on p.id = ph.part_id join hardware_items i on i.id = ph.item_id
    where p.job_id = j.id) as hardware_cost
from jobs j;

