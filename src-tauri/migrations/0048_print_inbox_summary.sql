-- Guma: what an Inbox file shows without unpacking it (CG, 25 Nov 2026).
--
-- 0047 shipped without this column: the desktop app was running in dev
-- while 0047 was being written, applied its first draft to the real
-- database, and the finished 0047 (with the column) then no longer matched
-- what had been applied -- the app would not start. 0047 is back to the
-- draft that ran, frozen like every shipped migration, and the column
-- comes here instead.
alter table print_inbox_files add column summary text not null default '{}';
