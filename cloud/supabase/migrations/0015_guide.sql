-- Mirror of src-tauri/migrations/0013_guide.sql for the hosted build.
-- See that file for why guidance is contextual chapters rather than a tour,
-- and why this is a table rather than a flag per chapter on shops.
create table if not exists guide_seen (
  shop_id uuid not null references shops on delete cascade,
  chapter text not null,
  seen_at timestamptz not null default now(),
  primary key (shop_id, chapter)
);

alter table guide_seen enable row level security;
