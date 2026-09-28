-- Mirror of src-tauri/migrations/0020_slice_files.sql. See that file for why
-- the bytes live apart from the row that names the file.
create table if not exists slice_files (
  import_id   uuid primary key references slice_imports on delete cascade,
  byte_size   bigint not null,
  stored_size bigint not null,
  encoding    text not null check (encoding in ('gzip-base64')),
  content     text not null,
  kept_at     timestamptz not null default now()
);
alter table slice_files enable row level security;
-- No shop_id of its own: the policy reaches through slice_imports, exactly
-- as slice_sections does.
create policy slice_files_rw on slice_files for all to authenticated
  using (exists (select 1 from slice_imports i
                  where i.id = import_id and i.shop_id = current_shop_id()))
  with check (exists (select 1 from slice_imports i
                       where i.id = import_id and i.shop_id = current_shop_id()));
