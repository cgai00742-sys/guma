-- Guma: more than one picture for a product (CG, 22 Oct: "Shelf items ...
-- multiple pictures, especially when multiple parts are assigned to them"
-- -- the Maui BathyTopo 3X 12" piece is several plates' worth of parts).
--
-- One row per picture. import_id says which plate it came from, when it
-- came from one: that is how the Shelf knows a plate's picture is already
-- there, and -- with image = '' -- that it was taken off on purpose and
-- must not be put back. A picture somebody added themselves has none.
--
-- products.photo (0041) stays, unused for display from here; its pictures
-- are carried across below, and a '' there (removed) is simply not copied.
create table product_photos (
  id         text primary key,
  shop_id    text not null references shops on delete cascade,
  product_id text not null references products on delete cascade,
  image      text not null,
  import_id  text references slice_imports on delete set null,
  sort       real not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_product_photos_product on product_photos (product_id, sort);
create unique index idx_product_photos_plate on product_photos (product_id, import_id)
  where import_id is not null;

insert into product_photos (id, shop_id, product_id, image, sort)
select lower(hex(randomblob(16))), shop_id, id, photo, 0
  from products where photo is not null and photo <> '';
