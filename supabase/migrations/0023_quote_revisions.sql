-- Mirror of src-tauri/migrations/0019_quote_revisions.sql.
alter table quotes add column if not exists change_cause text;
alter table quotes add column if not exists change_reason text;
