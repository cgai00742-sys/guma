-- Mirror of src-tauri/migrations/0021_archive_and_family.sql. See that file
-- for why a family is one nullable self-reference and why archiving keeps
-- every figure.
alter table jobs add column if not exists archived_at timestamptz;
alter table jobs add column if not exists related_to uuid references jobs on delete set null;
create index if not exists idx_jobs_related on jobs (related_to);
create index if not exists idx_jobs_archived on jobs (shop_id, archived_at);
