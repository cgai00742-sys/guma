-- Mirror of src-tauri/migrations/0029_job_printer.sql.
alter table jobs add column if not exists printer_id uuid references printers on delete set null;
