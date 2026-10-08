-- Mirror of src-tauri/migrations/0032_copy_states.sql.
alter table job_parts add column if not exists copy_states text;
alter table part_events add column if not exists copies text;
