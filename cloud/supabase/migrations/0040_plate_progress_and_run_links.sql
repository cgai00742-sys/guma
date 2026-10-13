-- Mirror of src-tauri/migrations/0036_plate_progress_and_run_links.sql.
alter table slice_imports add column if not exists progress text;
alter table part_events add column if not exists run_id uuid references print_runs(id) on delete set null;
