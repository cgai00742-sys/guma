-- Being shown the program, rather than handed it.
--
-- Guma opens on a full application: six screens, a rate card, a pipeline
-- board, a quote engine. Everything is discoverable and nothing is
-- explained, which is a fair description of most software and a poor one
-- for a tool whose whole promise is making a shop's own numbers legible.
-- Somebody who has to work out the program first has been handed a second
-- problem, not helped with the first.
--
-- WHY NOT A TOUR.
--
-- The obvious answer is a guided tour on first launch, and it is the wrong
-- one. A tour fires at the moment the user knows least about what they
-- need, covers features they have no use for yet, and trains a reflex of
-- dismissing whatever the program pops up. The published numbers are
-- unkind to it: core features average around a quarter adoption across B2B
-- products despite the tours, while short contextual prompts shown at the
-- moment of need complete far better.
--
-- So guidance here is a set of small chapters, each fired the first time a
-- shop actually reaches the thing it explains. The one about in-house work
-- appears when they first look at where in-house work would go; the one
-- about rate versioning appears the first time they change a rate. Each is
-- shown once, ever, and then never again.
--
-- A TABLE, NOT A COLUMN.
--
-- show_welcome (0002) is a single flag on shops because there was one
-- thing to remember. This is an open-ended and growing set, and a column
-- per chapter would mean a migration every time a sentence is added. A row
-- per chapter seen also records WHEN, which is the difference between "we
-- have shown this" and "we showed this before the feature existed" -- and
-- one day that will matter for deciding whether a rewritten chapter should
-- be shown again.
--
-- Composite primary key, so marking a chapter seen twice is a no-op rather
-- than a duplicate. The app inserts with `on conflict do nothing` and never
-- has to check first.
create table guide_seen (
  shop_id text not null references shops on delete cascade,
  chapter text not null,
  seen_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (shop_id, chapter)
);
