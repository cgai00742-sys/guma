-- Guma: what a print ACTUALLY costs, not just what it consumes.
--
-- Guma already counted the four costs that are easy to see: the material,
-- the electricity, the machine wear reserve, and the shop's own hours. A
-- shop reading that number would conclude it was doing better than it is,
-- because two of the largest real costs were missing entirely.
--
-- OVERHEAD. Rent, insurance, software subscriptions, internet, and the
-- power the building draws when nothing is printing are paid whether a
-- machine runs or not, and they are paid out of job margin. The standard
-- way to allocate them is per productive machine-hour: monthly overhead
-- divided by the machine-hours the shop actually bills in a typical month.
-- Two numbers a shop can answer are stored rather than one it cannot: no
-- owner knows their "overhead per hour", but every owner can add up a
-- month's fixed bills and estimate the hours their machines actually run
-- on paid work.
--
-- FAILURE. Plates fail. They warp, they clog, they shift, the power blips.
-- A failed plate burns its material and its machine hours twice and earns
-- once. Every serious costing guide for print services carries an
-- allowance for it, and a shop that leaves it out has simply moved the
-- loss somewhere it cannot see.
--
-- ALL THREE DEFAULT TO NULL, ON PURPOSE. Guma ships no rate for anyone's
-- shop and this is no different: a percentage compiled into this file
-- would be a recommendation the project has no business making, and a
-- shop's real figures are the only ones worth costing against. Null means
-- "not supplied", the cost panel says which line is missing and what it
-- would take to fill in, and every existing quote prices exactly as it did
-- before this migration -- nothing already sent moves by a cent.
--
-- The failure allowance is a COST, not a surcharge. It changes what the
-- shop knows it is earning; it does not change what the client is asked to
-- pay. A shop that finds its margin thin once failures are counted raises
-- a rate, deliberately, rather than discovering that its quotes silently
-- grew by eight percent.

alter table shops add column overhead_monthly numeric(12,2);
alter table shops add column productive_hours_month numeric(10,2);
alter table shops add column failure_pct numeric(5,2);
