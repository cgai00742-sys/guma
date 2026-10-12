-- Mirror of src-tauri/migrations/0035_part_spares.sql.
alter table job_parts add column if not exists spare_n integer not null default 0 check (spare_n >= 0);
