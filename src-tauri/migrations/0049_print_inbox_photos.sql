-- Guma: photos of a print, to judge it by (CG, 25 Nov 2026).
--
-- "That picture is critical in assuring that the print was successful ...
-- and it acts as a reminder in case they haven't synced the program for a
-- while." A printer with a camera keeps a snapshot from the end of every
-- print; it is saved here with the print in Prints to check, and stays with
-- it once approved, so the project's print carries its evidence.
--
-- Kept as a data: URL (a JPEG, resized to 1280px wide, ~150 KB): one row
-- per picture, never read by a list -- only when a card or a print asks.
create table print_inbox_photos (
  id         text primary key,
  shop_id    text not null references shops on delete cascade,
  inbox_id   text not null references print_inbox on delete cascade,
  -- camera_last: the end of the print. camera_first: the start.
  kind       text not null check (kind in ('camera_last', 'camera_first')),
  taken_at   text,
  data       text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (inbox_id, kind)
);
