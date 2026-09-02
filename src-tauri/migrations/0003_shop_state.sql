-- Guma: the shop's US state, for the tax-name helper only.
--
-- Nullable, no default -- most identity fields on `shops` already work this
-- way (address, email, phone are all plain nullable text). This one exists
-- solely to key src/lib/taxHelp.ts's suggestion box; it is never read by
-- pricing.ts and never changes a number on a quote.
alter table shops add column state text;
