-- Guma: a series holds the shop's own projects the way a client holds theirs.
--
-- CG, 30 Sept: "revamp the in-house master project to something more like a
-- series ... the way a client could submit multiple projects for us to
-- complete. Maui can be under the BathyTopo series and move along the
-- phases as it gets completed."
--
-- Until now the "program" was itself a PROJECT (jobs.related_to, 0021):
-- BathyTopo had a stage, gates and a place on the board, which a
-- collection of islands does not have. A series is a container -- a name,
-- a brief, optionally a parent series (BathyTopo › Hawaiian Islands) --
-- and every piece inside it is an ordinary project with its own stages.
--
-- Existing data is moved, not lost:
--   * every in-house project that had in-house projects filed under it
--     becomes a series with the same name and brief, and the SAME id, so
--     the mapping is exact;
--   * its children join that series and lose the related_to link that
--     was standing in for it;
--   * the old program project joins its own series as a piece, so any
--     hours or prints logged on it stay counted. If nothing at all was
--     recorded on it, it is archived (one click unarchives it) with a note
--     saying why, so the series is not cluttered with an empty shell.
create table series (
  id          text primary key,
  shop_id     text not null references shops on delete cascade,
  name        text not null,
  brief       text,
  parent_id   text references series on delete set null,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at text
);
create index idx_series_shop on series (shop_id);
create index idx_series_parent on series (parent_id);

alter table jobs add column series_id text references series on delete set null;
create index idx_jobs_series on jobs (series_id);

insert into series (id, shop_id, name, brief, created_at)
select j.id, j.shop_id, j.title, j.brief, j.created_at
  from jobs j
 where j.kind = 'inhouse'
   and exists (select 1 from jobs c where c.related_to = j.id and c.kind = 'inhouse');

update series set parent_id = (select j.related_to from jobs j where j.id = series.id)
 where (select j.related_to from jobs j where j.id = series.id) in (select id from series);

update jobs set series_id = related_to, related_to = null
 where kind = 'inhouse' and related_to in (select id from series);

update jobs set series_id = id, related_to = null
 where id in (select id from series);

insert into job_events (job_id, kind, body)
select j.id, 'note',
       'Became the ' || j.title || ' series. This project was empty, so it was archived; unarchive it if you want it back.'
  from jobs j
 where j.id in (select id from series)
   and not exists (select 1 from print_runs r where r.job_id = j.id)
   and not exists (select 1 from work_log w where w.job_id = j.id)
   and not exists (select 1 from job_parts p where p.job_id = j.id)
   and not exists (select 1 from slice_imports s where s.job_id = j.id)
   and not exists (select 1 from batches b where b.job_id = j.id);

update jobs set archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 where id in (select id from series)
   and archived_at is null
   and not exists (select 1 from print_runs r where r.job_id = jobs.id)
   and not exists (select 1 from work_log w where w.job_id = jobs.id)
   and not exists (select 1 from job_parts p where p.job_id = jobs.id)
   and not exists (select 1 from slice_imports s where s.job_id = jobs.id)
   and not exists (select 1 from batches b where b.job_id = jobs.id);
