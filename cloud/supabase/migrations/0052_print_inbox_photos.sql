-- Guma: photos of a print, to judge it by (CG, 25 Nov 2026). Twin of the
-- desktop's 0049 -- see it for the reasons.
create table if not exists print_inbox_photos (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops on delete cascade,
  inbox_id   uuid not null references print_inbox on delete cascade,
  kind       text not null check (kind in ('camera_last', 'camera_first')),
  taken_at   timestamptz,
  data       text not null,
  created_at timestamptz not null default now(),
  unique (inbox_id, kind)
);
alter table print_inbox_photos enable row level security;
create policy print_inbox_photos_shop_all on print_inbox_photos for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());
