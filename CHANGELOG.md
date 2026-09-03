# Changelog

Notable changes, newest first. Dates are the day the work landed.

## 1.0.0 — 2026-09-03

The first release meant to be installed by someone who is not the author.

Guma before this could price a job and then lost interest in it. It can now
carry one from the first phone call to a paid closeout sheet, and tell you
afterwards whether it was worth doing.

### The workflow layer

- **Stage gates.** A short checklist on each of the seven stages. The
  questions live in code (`src/lib/gates.ts`), only the answers live in the
  database — so a checklist can be reworded without a migration and without
  invalidating a shop's history. Some items are *automatic*: a quote priced, a
  deposit collected, a part off the machine. Those cannot be ticked by hand,
  which is the point. Every automatic item names the control that clears it.
- **Flags that explain themselves.** Overdue, stalled, no quote, not agreed,
  deposit unpaid, delivered-and-unpaid, under your own minimum, underwater.
  Each carries the cause with real numbers and one sentence of what to do.
  Derived on every render, never stored, so a flag disappears the moment the
  thing causing it is fixed.
- **A project page.** Stage rail, flags spelled out, the current gate, money
  with its payment ledger, the delivery window and whether it is committed,
  the handover record, and one activity log where notes, stage changes,
  payments and runs sit together.
- **Drafts.** A saved price is not a project. Save a draft and it stays off
  the board until someone takes it in; the board carries a count that links
  straight at them.
- **Clients**, with type, projects, active work, quoted value and what is
  owed — all derived, none of it a stored rollup. A row opens in place to show
  that client's projects.

### The money layer

- **Payments**, append-only. Recording one moves the deposit owed, the balance
  owed, the flags and the client ledger at once. Corrections are refunds, not
  edits.
- **Material at what you actually paid.** A purchase log feeding a weighted
  average, falling back to the figure typed at setup — and saying which of the
  two a quote is standing on. On the worked example, the setup guess of
  $0.095/g against a real $0.024/g spool moved the material line from $140.60
  to $35.52.
- **Quoted against actual.** Log build runs and your own hours; the project
  page compares them to the quote line by line, repriced from the quote's own
  frozen snapshot, and shows the margin you actually got.
- **A closeout one-pager**, printable. Post-mortem inside the shop, case study
  outside it, with the cost block on a toggle.

### The build sheet

- Parts, copies, and per-part QC: pending → printed → passed, with reprint as
  the branch back. A reprint needs a reason and is counted as the cost it is,
  because it burned material and machine time twice. The sheet locks to QC
  from Review onwards.

### Fixed

- **Dates were UTC.** Every calendar date the app stores — a payment's date,
  the day an hour was worked, a quote's expiry — was written from
  `toISOString()`. For a shop at UTC-10 that is a day into the future for ten
  hours of every working day, and it put a project one day overdue while the
  client still had until close of business. All of it now goes through
  `src/lib/dates.ts`.
- **A project could be saved and then never moved.** The intake gate read a
  brief that no screen could edit, and the approval gate read a quote status
  nothing could change. Both are editable now, and every automatic gate item
  is required by test to name the control that clears it.
- **SQLite integer division** silently costed every gram of material at zero
  in the `material_costs` view. Postgres hides this; SQLite does not.
- **`listJobs` had no total order**, so two projects saved in the same
  millisecond came back in whatever order the query planner felt like.

### Known limits

- One install, one computer. No sync between machines.
- **The browser build is not the supported path for 1.0.** It shares the
  pricing engine and the screens, and its migrations ship, but the five added
  in this release have not been applied to a live Postgres by anyone.
- Installers are unsigned; expect one warning on first open.
- No printer control, ever. That is OctoPrint's and Klipper's job.

### For contributors

- A shipped migration is frozen. `src/lib/migrations.test.ts` fails if one is
  edited; `npm run migrations:lock` records a new one.
- `npm run db:repair` fixes a database whose checksums have drifted.
- The top bar shows the running commit, so "am I looking at the new code?" is
  answerable at a glance.
