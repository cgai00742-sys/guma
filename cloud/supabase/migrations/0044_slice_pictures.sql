-- Mirror of src-tauri/migrations/0040_slice_pictures.sql.
alter table slice_imports add column if not exists thumbnail text;
alter table slice_imports add column if not exists sliced_at timestamptz;
