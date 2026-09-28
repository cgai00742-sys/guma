# Reserved — Guma Cloud

Nothing in this folder ships in the desktop app, and nothing in it is being
worked on right now. It is here so the hosted edition stays *possible*
without being a distraction.

**The editions, as decided 28 Sept 2026.** The offline desktop app is the
product: personal use and small shops, up to three printers. Guma Cloud is
the commercial edition and is intended to replace Voltage eventually — but
the core of what Voltage did belongs in the offline version first, and that
is where the work goes until it is solid.

## What is in here

- `supabase/migrations/` — the hosted twin of every desktop migration.

**These are not optional and they are not stale.** `schemaParity.test.ts`
reads them and fails the build when a desktop migration has no hosted twin,
column for column and policy for policy. That is deliberate: the expensive
version of this mistake already happened once, when the hosted database
drifted thirteen migrations behind and nobody could tell which of the two
schemas was the real one. Writing the twin at the same moment costs a
minute; reconstructing it later cost a day.

So: when a change adds a desktop migration, add the hosted one here in the
same commit. Do **not** apply it to any live Supabase project — offline
first, and a migration that exists only in a hosted database and not in the
repo is the exact failure above.

## What is NOT in here, and why

`src/lib/data.supabase.ts` stays where it is. The runtime dispatcher
(`src/lib/data.ts`) dynamically imports one backend or the other, and
`backends.test.ts` checks the two export the same function names. Moving
the file out of `src/` would break that import and gain nothing — the file
is already inert in the desktop build, which never loads it.
