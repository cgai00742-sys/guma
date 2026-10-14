-- Guma: a recorded print can be corrected, and the shelf follows.
--
-- CG, 14 Oct 2026: a 16h 26m Maui plate went in as "already printed" --
-- 355 g, 16.43 h, came off clean -- when it had been stopped at 15 hours
-- after ghost printing. The only way to fix it was to remove the run and
-- record it again, which nothing on screen suggested. Runs can now be
-- corrected in place; this keeps the spool honest when they are. The
-- insert and delete triggers (0006) only ever handled a run arriving or
-- going: a changed weight or spool moved nothing.
create trigger t_run_consume_update after update of units_used, material_id on print_runs
when old.consumed_at is not null
  and (coalesce(old.units_used, 0) <> coalesce(new.units_used, 0)
       or coalesce(old.material_id, '') <> coalesce(new.material_id, ''))
begin
  update materials set on_hand = coalesce(on_hand, 0) + coalesce(old.units_used, 0)
   where id = old.material_id;
  update materials set on_hand = max(0, coalesce(on_hand, 0) - coalesce(new.units_used, 0))
   where id = new.material_id;
end;
