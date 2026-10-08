-- Guma: the machine a project is booked on.
--
-- CG, 8 Oct 2026: Scheduled has to let the shop PICK the machine, not
-- just tick "a machine picked". The quote's printer is what it was priced
-- on; this is where it will actually run, which is often a different one
-- (the XL is free, the MK4 is not). Null: not picked yet.
alter table jobs add column printer_id text references printers on delete set null;
