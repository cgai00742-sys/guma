-- Mirror of src-tauri/migrations/0042_product_photos.sql.
create table if not exists product_photos (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops on delete cascade,
  product_id uuid not null references products on delete cascade,
  image      text not null,
  import_id  uuid references slice_imports on delete set null,
  sort       double precision not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_product_photos_product on product_photos (product_id, sort);
create unique index if not exists idx_product_photos_plate on product_photos (product_id, import_id)
  where import_id is not null;

insert into product_photos (shop_id, product_id, image, sort)
select shop_id, id, photo, 0 from products where photo is not null and photo <> '';

alter table product_photos enable row level security;
create policy product_photos_shop_all on product_photos for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());
