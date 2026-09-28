-- Mirror of src-tauri/migrations/0018_slice_variants.sql. See that file for
-- why a chosen variant is one column rather than a table, and for the 20%
-- time swing that makes choosing matter.
alter table job_parts add column if not exists chosen_section_id uuid references slice_sections on delete set null;
create index if not exists idx_job_parts_chosen on job_parts (chosen_section_id);
