-- Mirror of src-tauri/migrations/0027_gate_skips.sql.
alter table job_gates add column if not exists skipped text;
