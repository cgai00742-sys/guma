-- Guma: keep the file, not just what it said.
--
-- Reported by CG: "I already uploaded the file that was used to print the
-- piece and it's not there anymore." He was right, and it was not a display
-- bug. An import read the file, took its numbers and let the bytes go. The
-- project remembered that a file called H2S_Paddle grips_sliced.gcode.3mf
-- existed and what it predicted; it could not give you the file back.
--
-- For a shop that is the wrong half to keep. The whole reason a sliced file
-- is worth importing is that it is the exact thing that produced the object
-- -- reprint it in eight months and you want THAT file, not a file with the
-- same name off a laptop that has since been wiped.
--
-- WHY A SEPARATE TABLE. Every read of slice_imports -- the project screen,
-- the closeout, the build sheet -- would otherwise drag several megabytes
-- of G-code through it for a row that only wants a file NAME. Splitting the
-- bytes off means the heavy column is read only when somebody asks for the
-- file itself.
--
-- WHY TEXT AND NOT A BLOB. tauri-plugin-sql moves parameters as JSON, so a
-- byte array would be re-encoded anyway. The content is gzipped first and
-- then base64'd: G-code is text and compresses about five to ten times, so
-- the base64 overhead is paid on a much smaller thing and a typical plate
-- lands well under a megabyte.
--
-- Files above the cap in sliceFile.ts are NOT kept, and the import says so
-- rather than silently keeping nothing.
create table slice_files (
  import_id   text primary key references slice_imports on delete cascade,
  -- Size of the real file, so the screen can say what it is holding.
  byte_size   integer not null,
  -- Size actually stored, after gzip and base64.
  stored_size integer not null,
  encoding    text not null check (encoding in ('gzip-base64')),
  content     text not null,
  kept_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
