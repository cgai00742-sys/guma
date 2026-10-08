-- Mirror of src-tauri/migrations/0030_stock_holds.sql.
create table if not exists stock_holds (
  job_id      uuid not null references jobs on delete cascade,
  material_id uuid not null references materials on delete cascade,
  units       numeric not null check (units > 0),
  actor_id    uuid references profiles,
  at          timestamptz not null default now(),
  primary key (job_id, material_id)
);
create index if not exists idx_stock_holds_material on stock_holds (material_id);

alter table stock_holds enable row level security;
-- No shop_id of its own, so the policy reaches through jobs (as job_gates).
create policy stock_holds_shop_all on stock_holds for all
  using (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()))
  with check (exists (select 1 from jobs j where j.id = job_id and j.shop_id = current_shop_id()));

create or replace view stock_held with (security_invoker = true) as
select j.shop_id, h.job_id, j.ref, j.title, j.phase, h.material_id,
       h.units as held,
       coalesce((select sum(r.units_used) from print_runs r
                  where r.job_id = h.job_id and r.material_id = h.material_id), 0) as used,
       greatest(h.units - coalesce((select sum(r.units_used) from print_runs r
                  where r.job_id = h.job_id and r.material_id = h.material_id), 0), 0) as remaining
  from stock_holds h
  join jobs j on j.id = h.job_id
 where j.phase in ('scheduled', 'building', 'review')
   and j.archived_at is null;
