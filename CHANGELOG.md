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

### Wherever you are

Guma is downloaded and run by whoever wants it, so this release takes out the
places where it quietly assumed the United States.

- **No timezone setting, and there never will be one.** Dates are built from
  the operating system's own local calendar fields, so "today" is always the
  day your menu bar says it is. A stored timezone is a second source of truth
  that can disagree with the clock on screen; a picker is a question with a
  wrong answer available. Change your system's region and Guma follows.
- **Currency is the whole ISO list**, read from the runtime's own CLDR data
  and named in your language — not the ten-currency list that used to ship,
  which was a statement about whose money counted. The first guess comes from
  your machine's region; a region Guma doesn't recognise gets no guess rather
  than a wrong one.
- **Number and date formats come from the operating system.** The basis lines
  under a quote (`740 g at ...`, `21 h on ...`) now group and point the same
  way as the money beside them — a German quote reading "1,250 g" next to
  "1.250,00 €" was a bug the shop had to explain to a client.
- **Documents print on your paper.** A4 or Letter, derived from your region
  (A4 for anywhere Guma isn't sure, since it is the ISO standard and the
  larger share of the world), overridable in Settings. The quote and the
  closeout sheet were both laid out for US Letter, which crops or shrinks on
  an A4 printer.
- **The US state field only appears for US shops.** Its only job is to get the
  name of a US tax right — Hawaii's GET is not a "sales tax" — and it was the
  first thing a shop in Lagos or Lyon hit on the setup wizard.
- A test (`src/lib/locale.test.ts`) now walks the source and fails the build
  if `'en-US'`, `'USD'` or a timezone setting reappears anywhere it doesn't
  belong. Three separate bugs in this codebase have been exactly that.

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

### Render tests

The gap named in the 1.0 notes is closed. `jsdom` and Testing Library are now
dev dependencies, and three screens are tested as they actually draw:

- **Setup** — the state dropdown appears only for a US machine, the currency
  guess and its sample follow the locale, and no rate input arrives pre-filled
  with someone else's numbers.
- **Intake** — all three ways out exist, all three refuse until there is a
  client and a title, Save draft does not take the project in, Intake does and
  lands on the project rather than stranding you on the form, and every button
  locks while a save is in flight.
- **Project** — rendered against a real SQLite database with every migration
  applied and no mock below the screen, so it exercises the schema,
  `data.local.ts`, the dispatcher, `gates.ts`, `pricing.ts` and the page in one
  pass. It asserts the brief has an editor, the quote status has a control, and
  every unmet automatic gate item prints the `fix` hint that names what clears
  it — which is the three dead ends of "I tried to move a new project forward
  but no success", made permanent.

Every one of those bugs typechecked, passed its logic tests, and was broken the
moment a person looked at the screen. 176 tests now, up from 122.

### The suite runs in Chatham now

A test fixture built from `Date.UTC` passed on every UTC machine and failed
on the author's own, in Hawaii. `daysBetweenLocal` was right; the fixture was
counting UTC days and asserting local ones, so the answer depended on where
the machine was.

Fixtures now construct their instants locally, and `vitest` is pinned to
`Pacific/Chatham` — UTC+12:45, across the date line, with daylight saving.
Anything that survives it survives Berlin. `npm run test:tz` sweeps six zones
from UTC-10 to UTC+14, and the release workflow runs the sweep before
building. A test in `dates.test.ts` fails if the pin is ever removed, so the
coverage cannot evaporate quietly.

Three tests were wrong in a UTC+12:45 zone and one in UTC-10. None of them
were code bugs — which is the point: a suite that only runs in Greenwich
cannot tell correct code from code that agrees with Greenwich.

### For contributors

- A shipped migration is frozen. `src/lib/migrations.test.ts` fails if one is
  edited; `npm run migrations:lock` records a new one.
- `npm run db:repair` fixes a database whose checksums have drifted.
- The top bar shows the running commit, so "am I looking at the new code?" is
  answerable at a glance.
