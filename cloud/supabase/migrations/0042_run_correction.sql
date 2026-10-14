-- Mirror of src-tauri/migrations/0038_run_correction.sql: a corrected run
-- moves the shelf by the difference. CREATE OR REPLACE keeps the function's
-- privileges, so the revoke in 0018 still holds.
create or replace function public.run_consume() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'INSERT' then
    if new.material_id is not null and new.units_used is not null and new.consumed_at is null then
      update materials set on_hand = greatest(0, coalesce(on_hand,0) - new.units_used)
       where id = new.material_id;
      new.consumed_at := now();
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.material_id is not null and old.units_used is not null and old.consumed_at is not null then
      update materials set on_hand = coalesce(on_hand,0) + old.units_used where id = old.material_id;
    end if;
    return old;
  elsif tg_op = 'UPDATE' then
    if old.consumed_at is not null
       and (coalesce(old.units_used, 0) <> coalesce(new.units_used, 0)
            or old.material_id is distinct from new.material_id) then
      if old.material_id is not null then
        update materials set on_hand = coalesce(on_hand,0) + coalesce(old.units_used, 0) where id = old.material_id;
      end if;
      if new.material_id is not null then
        update materials set on_hand = greatest(0, coalesce(on_hand,0) - coalesce(new.units_used, 0))
         where id = new.material_id;
      end if;
    end if;
    return new;
  end if;
  return null;
end;$$;

drop trigger if exists t_run_consume_upd on print_runs;
create trigger t_run_consume_upd after update of units_used, material_id on print_runs
  for each row execute function public.run_consume();
