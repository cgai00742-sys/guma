-- Mirror of src-tauri/migrations/0034_copy_reprint_file.sql.
alter table part_events add column if not exists slice_import_id uuid references slice_imports(id) on delete set null;
