-- Guma: material set aside for a project.
--
-- CG, 8 Oct 2026, after Scheduled gained its spool check: two projects
-- each saw the whole shelf, so both could read "covered" against the same
-- 1 kg. A hold is the shop saying "this much of that spool is this
-- project's" -- the usual allocated-versus-available split in inventory.
--
-- One row per project and spool, replaced whenever the project sets aside
-- again. What is still held is DERIVED, never stored twice:
--   * print runs on the project draw the hold down as they consume the
--     spool (t_run_consume already takes them off on_hand), so the same
--     grams are never counted as both used and held;
--   * a hold only counts while the project is Scheduled, In build or in
--     Review. Delivered, moved back before Scheduled, or archived, and it
--     releases itself -- nobody has to remember to.
create table stock_holds (
  job_id      text not null references jobs on delete cascade,
  material_id text not null references materials on delete cascade,
  units       numeric not null check (units > 0),
  actor_id    text references profiles,
  at          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (job_id, material_id)
);
create index idx_stock_holds_material on stock_holds (material_id);

create view stock_held as
select j.shop_id, h.job_id, j.ref, j.title, j.phase, h.material_id,
       h.units as held,
       coalesce((select sum(r.units_used) from print_runs r
                  where r.job_id = h.job_id and r.material_id = h.material_id), 0) as used,
       max(0, h.units - coalesce((select sum(r.units_used) from print_runs r
                  where r.job_id = h.job_id and r.material_id = h.material_id), 0)) as remaining
  from stock_holds h
  join jobs j on j.id = h.job_id
 where j.phase in ('scheduled', 'building', 'review')
   and j.archived_at is null;
