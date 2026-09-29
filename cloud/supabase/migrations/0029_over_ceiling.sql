-- Mirror of src-tauri/migrations/0025_over_ceiling.sql.
alter table jobs add column if not exists over_ceiling text;
