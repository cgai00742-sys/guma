-- Mirror of src-tauri/migrations/0043_equipment_hardware.sql.
create table if not exists equipment (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops on delete cascade,
  name        text not null,
  kind        text not null default 'other'
              check (kind in ('dryer','wash_cure','fume','enclosure','iron','heat_gun','dehumidifier','other')),
  tracking    text not null check (tracking in ('hours','printers','overhead')),
  watts       numeric check (watts is null or watts >= 0),
  price       numeric check (price is null or price >= 0),
  life_hours  numeric check (life_hours is null or life_hours > 0),
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_equipment_shop on equipment (shop_id);

create table if not exists equipment_printers (
  equipment_id uuid not null references equipment on delete cascade,
  printer_id   uuid not null references printers on delete cascade,
  primary key (equipment_id, printer_id)
);

create table if not exists equipment_use (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops on delete cascade,
  job_id       uuid not null references jobs on delete cascade,
  equipment_id uuid not null references equipment on delete cascade,
  hours        numeric not null check (hours > 0),
  used_on      date,
  note         text,
  actor_id     uuid,
  created_at   timestamptz not null default now()
);
create index if not exists idx_equipment_use_job on equipment_use (job_id);

create table if not exists hardware_items (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops on delete cascade,
  name        text not null,
  unit_cost   numeric(12,4) not null default 0 check (unit_cost >= 0),
  markup_pct  numeric(6,2) not null default 0 check (markup_pct >= 0),
  stock_base  numeric not null default 0,
  reorder_at  numeric not null default 0 check (reorder_at >= 0),
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_hardware_shop on hardware_items (shop_id);

create table if not exists part_hardware (
  part_id   uuid not null references job_parts on delete cascade,
  item_id   uuid not null references hardware_items on delete cascade,
  per_copy  numeric not null check (per_copy > 0),
  primary key (part_id, item_id)
);

create table if not exists assembly_hardware (
  assembly_id uuid not null references assemblies on delete cascade,
  item_id     uuid not null references hardware_items on delete cascade,
  per_unit    numeric not null check (per_unit > 0),
  primary key (assembly_id, item_id)
);

create table if not exists hardware_use (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops on delete cascade,
  job_id      uuid not null references jobs on delete cascade,
  item_id     uuid not null references hardware_items on delete cascade,
  qty         numeric not null check (qty > 0),
  unit_cost   numeric(12,4) not null check (unit_cost >= 0),
  source      text not null default 'manual' check (source in ('manual','assembly')),
  assembly_id uuid references assemblies on delete set null,
  note        text,
  actor_id    uuid,
  created_at  timestamptz not null default now()
);
create index if not exists idx_hardware_use_job on hardware_use (job_id);
create index if not exists idx_hardware_use_item on hardware_use (item_id);

create or replace view hardware_stock with (security_invoker = true) as
select
  i.id as item_id,
  i.shop_id,
  coalesce((select sum(h.qty) from hardware_use h where h.item_id = i.id), 0)
  + coalesce((select sum(ph.per_copy * (p.printed_n + p.passed_n + p.spare_n))
                from part_hardware ph join job_parts p on p.id = ph.part_id
               where ph.item_id = i.id), 0) as used
from hardware_items i;

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
  (select coalesce(sum(w.hours),0) from work_log w where w.job_id = j.id and w.kind='admin') as admin_hours,
  (select coalesce(sum(u.hours),0) from equipment_use u where u.job_id = j.id) as equipment_hours,
  (select coalesce(sum(u.hours * (coalesce(e.watts,0) / 1000.0 * coalesce(s.electricity_rate_kwh,0)
                                  + case when e.life_hours > 0 then coalesce(e.price,0) / e.life_hours else 0 end)),0)
     from equipment_use u join equipment e on e.id = u.equipment_id join shops s on s.id = j.shop_id
    where u.job_id = j.id)
  + (select coalesce(sum(r.hours * (coalesce(e.watts,0) / 1000.0 * coalesce(s.electricity_rate_kwh,0)
                                  + case when e.life_hours > 0 then coalesce(e.price,0) / e.life_hours else 0 end)),0)
     from print_runs r
     join equipment_printers ep on ep.printer_id = r.printer_id
     join equipment e on e.id = ep.equipment_id and e.tracking = 'printers'
     join shops s on s.id = j.shop_id
    where r.job_id = j.id) as equipment_cost,
  (select coalesce(sum(h.qty * h.unit_cost),0) from hardware_use h where h.job_id = j.id)
  + (select coalesce(sum(ph.per_copy * (p.printed_n + p.passed_n + p.spare_n) * i.unit_cost),0)
     from part_hardware ph join job_parts p on p.id = ph.part_id join hardware_items i on i.id = ph.item_id
    where p.job_id = j.id) as hardware_cost
from jobs j;

-- Shop-scoped, like every other table. The link tables are reached through
-- their parent's shop.
do $$ declare t text; begin
  foreach t in array array['equipment','equipment_use','hardware_items','hardware_use']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all using (shop_id = current_shop_id())
         with check (shop_id = current_shop_id())', t || '_shop_all', t);
  end loop;
end $$;
alter table equipment_printers enable row level security;
create policy equipment_printers_shop_all on equipment_printers for all
  using (exists (select 1 from equipment e where e.id = equipment_id and e.shop_id = current_shop_id()))
  with check (exists (select 1 from equipment e where e.id = equipment_id and e.shop_id = current_shop_id()));
alter table part_hardware enable row level security;
create policy part_hardware_shop_all on part_hardware for all
  using (exists (select 1 from hardware_items i where i.id = item_id and i.shop_id = current_shop_id()))
  with check (exists (select 1 from hardware_items i where i.id = item_id and i.shop_id = current_shop_id()));
alter table assembly_hardware enable row level security;
create policy assembly_hardware_shop_all on assembly_hardware for all
  using (exists (select 1 from hardware_items i where i.id = item_id and i.shop_id = current_shop_id()))
  with check (exists (select 1 from hardware_items i where i.id = item_id and i.shop_id = current_shop_id()));
