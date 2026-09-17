/**
 * Which rate card is the one in force.
 *
 * Rates are versioned by INSERT, never edited in place: a quote keeps its
 * own snapshot, and a rate change later must not be able to move a number
 * underneath a quote that was already sent. That part works.
 *
 * What did not work is reading the newest one back. `effective_from` is a
 * DATE, so two cards written on the same day tie on it -- and that is not a
 * rare case, it is the ordinary one. The wizard writes a rate card the
 * moment it creates the shop (because rate_cards has NOT NULL columns with
 * no defaults), and writes another a few questions later when it asks what
 * an hour of your time is worth. Both land on today.
 *
 * `order by effective_from desc limit 1` then picks between them with no
 * rule at all. SQLite returns the FIRST of the tied rows, so the rate a
 * person typed was written to the database and never read back: saved,
 * invisible, and indistinguishable from not saving at all. The same is true
 * of any two rate changes made on one day, from the wizard or from Settings.
 *
 * rowid is SQLite's insertion order, so it breaks the tie the way a person
 * means it: same effective date, later entry wins. It is stable here
 * because nothing in this program vacuums, which is the one operation that
 * renumbers it. The hosted backend has the same shape and the same fix --
 * see data.supabase.ts, where created_at does this job.
 */
export const LATEST_RATE_CARD = 'order by effective_from desc, rowid desc'
