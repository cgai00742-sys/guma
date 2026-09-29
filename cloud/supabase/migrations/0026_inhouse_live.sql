-- Mirror of src-tauri/migrations/0022_inhouse_live.sql.
update jobs
   set taken_in_at = created_at
 where kind = 'inhouse' and taken_in_at is null;
