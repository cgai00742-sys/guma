-- Mirror of src-tauri/migrations/0024_stock_counts.sql.
create table if not exists material_counts (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references shops on delete cascade,
  material_id  uuid not null references materials on delete cascade,
  counted_on   date not null default current_date,
  counted_qty  numeric not null check (counted_qty >= 0),
  delta        numeric not null,
  note         text,
  recorded_by  uuid references profiles,
  created_at   timestamptz not null default now()
);
create index if not exists idx_material_counts_material on material_counts (material_id, counted_on desc);

alter table material_counts enable row level security;
create policy material_counts_shop_all on material_counts for all
  using (shop_id = current_shop_id()) with check (shop_id = current_shop_id());

create or replace function public.apply_material_count() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'INSERT' then
    update materials set on_hand = greatest(0, coalesce(on_hand, 0) + new.delta) where id = new.material_id;
    return new;
  elsif tg_op = 'DELETE' then
    update materials set on_hand = greatest(0, coalesce(on_hand, 0) - old.delta) where id = old.material_id;
    return old;
  end if;
  return null;
end;$$;
revoke execute on function public.apply_material_count() from public;

drop trigger if exists t_count_stock on material_counts;
create trigger t_count_stock after insert or delete on material_counts
  for each row execute function public.apply_material_count();
