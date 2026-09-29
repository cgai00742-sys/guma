-- Mirror of src-tauri/migrations/0023_sell_branch.sql.
alter table shops add column if not exists sell_branch text
  check (sell_branch is null or sell_branch in ('clients', 'selling', 'both'));
