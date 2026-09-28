-- Guma: real electricity cost, and the columns Settings needed all along.
--
-- Every field here was already reachable by SQL (legal_name, address, email,
-- phone, license_no, tax_label, tax_pct, terms_text, revision_policy,
-- payment_info all exist on `shops` since 0001) — Settings just never grew a
-- screen to edit them. This migration adds the two genuinely new numbers:
--
--   shops.electricity_rate_kwh  — the shop's own $/kWh, off their utility
--                                  bill. Never looked up or assumed: rates
--                                  vary by utility, not just region, and a
--                                  wrong guess baked into someone's margin
--                                  is worse than an honest blank.
--   printers.watts               — a machine's rated power draw while
--                                  printing.
--
-- Both are nullable on purpose. A shop that skips them still gets a working
-- quote — margin just falls back to treating machine time as break-even
-- (see pricing.ts) and the UI says so, rather than either blocking setup or
-- silently pretending to a precision that isn't there.

alter table shops    add column if not exists electricity_rate_kwh numeric(8,4);
alter table printers add column if not exists watts                numeric(8,1);
