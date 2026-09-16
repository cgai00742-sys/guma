-- Retiring a machine -- the hosted mirror of 0011_retire_machines.sql.
-- See that file for why retiring exists and why deleting is refused once a
-- machine has build history.
alter table printers add column if not exists archived boolean not null default false;

create index if not exists idx_printers_live on printers (shop_id, name) where archived = false;
