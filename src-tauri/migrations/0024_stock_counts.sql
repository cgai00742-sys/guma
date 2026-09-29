-- Guma: when somebody weighs a spool, that is a record, not an overwrite.
--
-- Stock has moved three ways since 0006: a purchase adds (0005), a print
-- run takes away -- failed or not, it burned the filament (0006) -- and
-- the shop corrects the count by typing a new number over the old one.
-- That third way left no trace. A spool that "lost" 300 g between two
-- weighings is either a print nobody logged or a scale that disagrees
-- with the slicer, and both are worth knowing; an overwrite erased the
-- evidence of either. It also raced: the Materials screen saved whatever
-- on-hand figure it had loaded, so renaming a material after a print had
-- run put the printed filament back on the shelf.
--
-- So a count is its own row. It stores what was counted AND the difference
-- from what Guma thought was there, which is the number worth reading
-- later. The trigger applies the difference rather than the count, so a
-- count followed by a purchase deleted later still nets correctly.
--
-- Nothing else writes on_hand any more: purchases, runs and counts, each
-- a row somebody can point at. That is the ledger CG asked for -- "more
-- material added and averaged for costs... the same system that needs to
-- be drawn down for usage based on projects."
create table material_counts (
  id           text primary key,
  shop_id      text not null references shops on delete cascade,
  material_id  text not null references materials on delete cascade,
  counted_on   text not null default (date('now')),
  counted_qty  numeric not null check (counted_qty >= 0),
  -- counted minus what Guma believed was on hand at that moment.
  delta        numeric not null,
  note         text,
  recorded_by  text references profiles,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index idx_material_counts_material on material_counts (material_id, counted_on desc);

create trigger t_count_stock_insert after insert on material_counts
begin
  update materials set on_hand = max(0, coalesce(on_hand, 0) + new.delta) where id = new.material_id;
end;
create trigger t_count_stock_delete after delete on material_counts
begin
  update materials set on_hand = max(0, coalesce(on_hand, 0) - old.delta) where id = old.material_id;
end;
