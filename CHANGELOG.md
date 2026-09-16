# Changelog

Notable changes, newest first. Dates are the day the work landed.

## Unreleased

The first round of changes driven by someone actually using the app rather
than reading its tests.

### Fixed: the tables were not tables

Reported as "click a client, open the drawer, close it again, and the other
client jumps to the top and looks wrong in position." It was worse than
that, and it was on screen the whole time.

`.row` is the design system's flex utility for list rows. Two screens — the
Clients table and the Projects list — put it on a `<tr>`, which set
`display:flex` on a table row. A row with `display:flex` is not a table row:
its cells stop being table cells, so they stop taking part in the table's
column widths, so every row sized itself independently and none of them
lined up with the header. Money and dates wrapped mid-value. Expanding a row
inserted a genuine table-row into the middle of that, which regrouped the
browser's anonymous table boxes and made the remaining rows physically move
— the jump.

Nothing caught it, and nothing in this repo could have: the render tests
draw into jsdom, which performs no layout at all and will happily report
that a completely scrambled table is fine. So the fix comes with a different
kind of test — `src/lib/styles.test.ts` reads every `className` the app uses
and checks it against the stylesheet, and fails if a class on a `<tr>`,
`<td>` or `<th>` changes that element's display, naming the file, the line
and the rule to add. It also fails on any class no stylesheet defines. Both
checks were run against the broken code first, to be sure they see it.

### Rows stay where you click them

Only one drawer is open at a time, so opening a row below an open one closes
that one first and everything shifts up — including the row you were aiming
at, while you are still looking at where it used to be. Browsers have a
feature for this, CSS scroll anchoring, and every browser has it except
WebKit — which is exactly what the desktop app is, since a Tauri window on
macOS is a WKWebView. So Guma does it itself, for the client list, the
material purchase logs and the build sheet's part history.

### Clickable rows are reachable from the keyboard

guma.css has carried a `tr.row:focus-visible` rule the whole time, for a
state those rows could not reach: a `<tr>` with an `onClick` and nothing
else cannot be focused and announces itself as a plain row of data. The
stylesheet was describing a control. Now the markup is one — Tab to a row,
Enter or Space to open it, and `aria-expanded` says whether it is open.

### One box that finds anything

A shop's things live on four screens, two of which are tabs inside a third.
Knowing that a spool of grey PETG is under Shop settings → Materials is
knowledge about Guma, not about running a print shop. So there is now a
search box in the top bar — ⌘K, or Ctrl-K — that finds projects, clients,
machines and materials, and goes to them. A client result opens their row.
A machine result opens the machines tab. Arrows move, Enter goes.

Every list has its own filter field too, and all of them run the same
matcher, so a client who can be found by phone number in the top bar can be
found by phone number on the Clients screen. Three rules it follows:

- **Every word must match.** "hafen bracket" means both, because the second
  word is supposed to narrow. The board's old filter OR'd its three fields
  together and so matched nothing at all for that query.
- **Accents do not count,** both directions. A client entered as *Muñoz*
  is found by typing `munoz`, and one entered as *Munoz* by typing `Muñoz`.
  They are the same person; a tool that disagrees is wrong.
- **Nothing is fuzzy.** An empty result means "you do not have one of
  those" — which is only useful if it is reliably true.

Searchable text is not limited to what a row displays: a client's phone
number and email address, a project's reference number, a machine's
technology. A shop looking at a missed call types the number.

And a filtered list never looks like an empty one. "Nobody matches
'zzz' — you have 4 clients on file" is a different sentence from "no
clients yet", because the failure being prevented is somebody searching a
name, seeing nothing, and entering that client a second time.

### Fixed: a machine you added did not appear

The machines tab read its list from the shop context once, on first render,
and then never looked at it again. Adding a machine saved it correctly and
re-rendered from the stale copy — so the machine was in the database and not
on the screen, and the only way to see it was to leave the tab and come
back. From the outside that is indistinguishable from the save having
failed. It is the largest part of what "the save feature is not smooth"
meant, and there is now a test that renders the screen, adds a machine, and
fails if the machine is not visible.

### Saving is something you can see happen

Every save button did the same three things: disable itself, say "Saving…"
for about eighty milliseconds, and go back to saying "Save". On a local
SQLite file that is far too fast to see, so the button appeared to do
nothing at all and the only way to check was to navigate away and back.

Buttons now say **Saved ✓** and hold it long enough to read, adding a client
or a machine says their name back, and a refusal shows the refusal rather
than a tick. (The first version of this read the error off the hook right
after awaiting, which is reading the render *before* the failed one — it
caught the failure and displayed nothing. The save now hands back what
happened rather than requiring a re-render to find out.)

### You can get rid of a machine

Machines could be added and never removed, so a printer you sold stayed in
every quote dropdown forever and a typo was permanent.

Deleting is right for a machine nothing points at, and wrong for one with
build runs behind it — those hours are what made old projects cost what they
cost, and removing the machine would rewrite finished money. So Guma deletes
when it is safe and **retires** when it is not: a retired machine keeps every
run it ever did and disappears from everywhere work is priced, including
from what a connected AI can see. Both options are offered together, with
the difference stated, before either is pressed.

### Intake stops you creating the same client twice

The client field decided whether a name was new by exact string equality,
then said so confidently — so typing `hafen gmbh` for a client saved as
*Hafen GmbH* announced a new client. It was not one (the save matches
case-insensitively), so the label was a lie in the reassuring direction.

It now uses the rule the save actually uses, and a near miss stops and asks:
*"Hafen" — this will create a second client. Did you mean Hafen GmbH?* with
a button that takes the spelling already on file. Three ledgers called
*Hafen*, *Hafen GmbH* and *Hafen Gmbh*, each holding a third of the money,
is the kind of mess nothing in the app would ever have pointed out.

### You can add and remove clients

A client used to come into existence only as a side effect of saving a quote.
That made the Clients screen a history of who you had already billed rather
than a list of who you work with — you could not enter the people you already
know, fix a name typed wrong on the first job, or remove one created by a
typo. All three work now, and intake has a picker so a repeat job joins the
ledger it belongs to instead of creating a second client from a different
spelling.

Deleting a client who has projects is refused, on purpose, and says how many
are in the way. `jobs.client_id` does not cascade: a cascade would mean that
tidying up a typo in the client list silently deleted payments the shop had
actually received.

### What a print really costs

Guma counted four costs — material, power, machine wear, your own hours — and
silently treated two of the largest as zero.

- **Overhead.** Rent, insurance, software, internet, the building's own power.
  Paid whether or not a machine runs, and paid out of job margin. Allocated
  per productive machine-hour, from two figures a shop can actually answer:
  a month of fixed bills, and the machine-hours it really bills in a month.
- **Failed plates.** A failed plate burns its material and its hours twice and
  earns once. An allowance for it is standard in every serious costing guide
  for print services, and a shop that leaves it out has moved the loss
  somewhere it cannot see. Applied to material, power, wear and overhead — not
  to design hours, since a failed plate does not make you model the part again.

On the worked example the effect is not marginal. The same €1,205.90 job that
showed €257 of margin shows **€65 once overhead and failures are counted** —
25% down to 5%. Nothing about the quote changed; only what the shop knows.

Both default to blank, and blank is not zero: an unsupplied cost is *named*
on the quote's cost panel with the field that would fill it in, and the total
says it is incomplete. **Neither changes what a client is charged.** A shop
whose margin looks thin once failures are counted raises a rate deliberately,
rather than finding out later that every quote had quietly grown.

### Fixed: the cost panel was overstating cost

It listed the machine's hourly *rate* as a cost. That rate is a price the shop
chose, not money it spends — so every shop that had filled in its electricity
rate was shown a cost higher than the truth and a margin lower than it, which
is the direction of error that makes a shop turn down work it should take.

The panel is now a real breakdown: every cost line, a total, cost per piece,
the break-even price, and what you keep.

### The app opens on the work

"New project" was a tab, which made a blank form the shop's home screen and
put *starting* something on the same footing as looking at everything you
have — a quoting app's shape, not a project manager's. Projects is home; New
project is a button, one click from anywhere.

An empty board now teaches instead of showing seven empty columns: three
numbered steps in the order the work actually happens, with the middle one
being "tell Guma what it costs you to run", because a shop that skips it gets
a flattering margin and will not find out for a year. It disappears for good
once there is one project.

Every cost input is on one Settings tab — *What it costs you* — rather than
one buried under Identity and three never asked at all.

### Also

- `guma_price_quote` over MCP returns the full owner-only cost block, and
  refuses to report a margin as fact while any cost line is missing.
- The MCP build no longer copies the web app's `public/` folder into the
  server bundle.
- 234 tests, up from 211, including a render suite for the Clients screen —
  written because two hundred passing tests never noticed you could not add a
  client, since every one of them tested what the code did rather than what a
  person could do with it.

### American English, throughout

The app was a mix of British and American spelling — "Labour", "modelling",
"colour", "licence", "fibre", "defence" — left over from copy written
without a fixed house style. All of it is now American English: labels,
placeholders, hint text, the composite-filament option, the Hawaii GET tax
note, and the "Design and modelling" line on the priced quote itself, which
is the one that goes out to a client. Nothing that touches the database
changed — `RunOutcome`'s stored `'cancelled'` value and the `print_runs`
check constraint it mirrors are untouched; only the "Cancelled part way"
label a shop actually reads was renamed to "Canceled part way".

### Currency defaults to $ only when there is nothing else to go on

`osCurrency()` still reads the region off the OS locale and guesses that
region's real currency — a machine set to German or British English keeps
getting EUR or GBP, not dollars. The one change: where it used to hand back
`''` and leave the field blank, it now falls back to USD, but only when the
OS gives no usable region signal at all. A blank field forced everyone
through a dropdown on first run for no reason; a wrong-looking guess for a
detected non-US shop would have been worse. This is a narrower exception
than "always default to $", by design — `currencyForRegion()` itself, and
its test asserting an unknown region gets `''` rather than a guess, are
unchanged.

### No timezone setting, and there still isn't one

Guma was asked to "base the app to HST" — it already does the equivalent
for wherever it's running, on purpose. Every date in the app is built from
the OS clock's local calendar fields (`dates.ts`), never from a stored zone
or a UTC instant reinterpreted later, so "today" always matches the clock in
the corner of the screen, in Honolulu or anywhere else, with nothing to
configure and nothing that can drift out of sync. Hardcoding HST would have
been a regression against that — and against the multi-timezone test sweep
that exists specifically to catch it (`npm run test:tz`, six zones from
UTC-10 to UTC+14).

### Setup tells you what things cost

Setup carried a notice reading "Guma ships no default rates on purpose — a
number pre-filled here would be a recommendation, and no tool knows what
your hour is worth", and then, two fields later, "machine price ÷ lifetime
hours is a fair start". It told you the formula and left you to do the
division, in a form, on a screen that had every input it needed a few pixels
away. Principle is not much use to someone staring at an empty box who
guesses, guesses low, and finds out a year later.

There is now guidance beside the rate and cost fields, in three tiers,
ranked by how much authority each deserves and never mixed up:

- **Yours** — arithmetic on numbers you supplied. Wear per hour from what
  the machine cost, the hours you expect out of it and what you spend a year
  on nozzles and belts; electricity per print hour from the wattage and your
  own kWh rate; what an hourly rate comes to in a day and a year. This tier
  offers a button that fills the field, because accepting your own division
  is not accepting a recommendation.
- **Your history** — your finished jobs, added up. What a delivered job is
  actually worth here, what an hour logged against a job actually returns,
  what margin survives to the bottom. Never fills a field: what you have
  been getting and what you should charge are different questions.
- **Published** — what other shops charge, per a named source, with the URL
  and the date attached. Nine cited figures covering machine time by tier,
  CAD rates, filament cost, markup multiples, machine life, annual
  consumables, shop minimums and deposits.

Every input still starts empty and stays empty. Nothing is pre-filled, so
nothing is recommended by default — the guidance sits underneath, and you
have to reach for it.

### The guidance is rows, not paragraphs

The first version of the above wrote prose under each field. It was accurate
and far too long to read, which makes being accurate beside the point. It is
now the same shape as the "what this does to a typical project" panel that
was already on that screen: a label on the left, a figure on the right, mono
and tabular so a column of them lines up. Anything that could not survive
being a row was cut rather than shrunk, and the source is a short "LayerMath
2026" rather than a full URL in the body text.

(If the chips and rules look unstyled after pulling this, the stylesheet is
`public/guma.css` — a static asset that Vite never hot-reloads. Hard-reload
the window.)

### Published rates do not cross a currency

The hard part of the above. Every published range was collected in one
currency in one market: "$25–45/hr" is useful in Honolulu and actively
misleading in Kraków, and Guma runs wherever it is downloaded. Converting
would be worse still — there is no exchange rate in a local-first app, and a
stale one turns a cited figure into a fabricated one.

So a figure tagged with a currency is shown only to a shop invoicing in that
currency. Everyone else gets the portable half — markup multiples, deposit
percentages, machine lifetime hours, all of which mean the same thing
anywhere — plus a plain statement that Guma has no published rate data for
their market and that their own history will be the better guide. Same rule
as locale.ts: a blank is honest, a wrong figure that looks researched is
not. It is enforced by `benchmarks.test.ts` at the function level and by a
render test at the screen level, both of which were run against a
deliberately broken version first to confirm they see it.

The table also expires. `REVIEWED_ON` records when a human last checked
every figure against its source, and the suite fails once that is eighteen
months old, because a 2026 figure sitting unexamined in 2029 is worse than
no figure — it still looks like research.

### An unmeasured job is not a perfect job

The history tier counts only delivered work that had something recorded
against it. A delivered project with no runs and no logged hours has an
actual cost of zero, and counting those would report 100% margin on them —
turning the one feature meant to tell a shop the truth about its pricing
into the most confident liar in the app. Those jobs are reported separately,
as the size of the blind spot, and everything is a median with the middle
half of the range beside it so that one catastrophe cannot move the number a
shop sets its rates by.

358 tests, up from 310.

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

### Connect your own AI — `guma-mcp`

Guma does not call a model. A model calls Guma.

`npm run mcp:build` produces `mcp/dist/guma-mcp.mjs`, a dependency-free MCP
server you point Claude, Cursor or anything else that speaks the protocol at.
Eleven tools: read the shop and its rates, price a job with Guma's own engine,
read projects with their gates and flags, create a draft, add notes, tick
manual gate items, advance a stage whose gate is clear, log runs and hours.

The design decision worth stating: the server runs `src/lib/data.local.ts`
**unmodified**, by aliasing the Tauri SQL plugin to a `node:sqlite` connection
at build time. There is no second data layer for a model to be wrong in, and
no way for the server and the app to disagree about what a project is. The
same holds for money — `guma_price_quote` runs `src/lib/pricing.ts` against
the shop's own rate card.

That is what makes the one rule structural instead of promised. A model
supplies hours and grams; it cannot supply a price, because **no tool accepts
one**. And no tool can record a payment, move a quote to accepted, change a
rate, take a draft in, or delete anything — a list that `tools.test.ts` fails
on if it ever shrinks.

Consequences: no API key field, no provider list, no prompt templates, no GPU,
and nothing to rewrite when models change. Needs Node 22+ to run the server;
the app itself still needs nothing. Anything an assistant creates arrives as a
**draft**, off the board, for a person to decide on.

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
