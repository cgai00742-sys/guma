-- Retiring a machine.
--
-- A shop can add machines and has never been able to get rid of one. Sell
-- a printer, and it stays in every dropdown forever; add one with a typo in
-- the name, and the typo is permanent. That is the same complaint the
-- clients list drew, and it has the same shape of answer.
--
-- Deleting outright is only safe for a machine nothing points at. Once a
-- build run has been logged against a printer, deleting it would take the
-- machine hours out of every project it ever ran -- which is to say it
-- would change what those projects cost, retroactively, and quietly. Guma
-- refuses that (see deletePrinter) and offers this instead.
--
-- Retired machines keep every run they ever did and disappear from the
-- pickers. Mirrors materials.archived, which already works exactly this
-- way, down to the column name -- one idea, spelled one way.
--
-- Not null with a default of 0, so every machine that already exists is,
-- correctly, not retired. This is the one case where a default is right:
-- "we did not ask" and "no" are genuinely the same answer here, unlike a
-- cost figure, where they are not (see 0010_true_cost.sql).
alter table printers add column archived integer not null default 0;

-- Partial index, matching idx_materials_shop: the pickers only ever ask for
-- the machines still in service, and that is the query worth indexing.
create index idx_printers_live on printers (shop_id, name) where archived = 0;
