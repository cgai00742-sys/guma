-- Mirror of src-tauri/migrations/0017_run_from_slice.sql. See that file for
-- why a run points at its import rather than an import becoming a run.
alter table print_runs add column if not exists slice_import_id uuid references slice_imports on delete set null;
create index if not exists idx_print_runs_slice on print_runs (slice_import_id);
