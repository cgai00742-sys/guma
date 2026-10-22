-- Guma: each plate's picture and the date it was sliced, read from the file
-- (CG, 22 Oct: "designing the parts to be more recognizable ... the data in
-- the gcodes identifies when the part was printed"). The file knows when it
-- was SLICED, not printed; the printed date stays with the print.
alter table slice_imports add column thumbnail text;
alter table slice_imports add column sliced_at text;
