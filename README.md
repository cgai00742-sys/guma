<div align="center">
  <img src="public/brand/guma-mark.svg" width="72" alt="">
  <h1>Guma</h1>
  <p><strong>Quoting, costing and margin for small 3D-print shops.</strong><br>
  The business layer, not another printer dashboard.</p>
</div>

---

Most print-farm software fights over controlling machines. OctoPrint, Klipper,
Printago and SimplyPrint all do that, and some of them do it free.

Almost nobody handles the part that decides whether the shop survives: what a
job costs you, what you charge for it, what margin is left after you pay
yourself, and the piece of paper the client signs. For most small shops that
job is done by a spreadsheet, badly.

Guma is that layer. It reads your machines; it does not drive them.

## What it does today

**Quoting and money**

- **Live quoting.** Enter a job in front of the client and watch the price build
  line by line — design time, material, machine time, wear, finishing.
- **Cost and margin, for your eyes.** What the job costs *you*, with your own
  hours counted at the rate you charge, so margin means what is left after
  paying yourself.
- **A quote PDF** with your logo, the arithmetic behind every line, the deposit,
  your terms and a signature rule.
- **Material priced at what you actually paid.** Log a spool purchase and Guma
  costs your filament at the weighted average of every purchase, not at a
  figure typed once during setup. Until you log one, it says the number is an
  estimate rather than pretending otherwise.
- **Payments, append-only.** Record a deposit or a balance; the owed figures,
  the flags and the client's ledger all move at once. Nothing is ever "marked
  paid" — a mistake is corrected with a refund, which is what an accountant
  expects to find.

**Running the work**

- **A pipeline board.** Seven stages, drag to advance. Every card carries a
  three-slot signal strip — money owed, overdue or stalled, promise at risk —
  so the board reads by pattern before you read a word.
- **Stage gates.** A short checklist per stage. Some items are automatic: a
  quote priced, a deposit collected, a part off the machine. You clear those by
  doing the thing, not by ticking a box.
- **Flags that say what to do.** Overdue, stalled, not agreed, deposit unpaid,
  delivered-and-unpaid, under your own minimum, underwater. Each one carries the
  cause with real numbers in it and one sentence of what to do about it.
- **A build sheet.** Parts, copies, and per-part QC. A reprint needs a reason —
  and it is counted as the cost it is, because it burned material and machine
  time twice.
- **Clients.** Not a rolodex: type, projects, active work, quoted value and what
  they still owe, all derived from real rows.

**Knowing whether it was worth it**

- **Quoted against actual.** Log build runs and your hours, and the project page
  shows the two side by side, line by line, with the margin you actually got.
- **A closeout one-pager.** Printable. The post-mortem inside the shop; a case
  study outside it, with the cost block on a toggle.

**Not built, on purpose:** anything that drives a printer. Guma reads machines;
it does not control them. Slicing, queueing and machine control are OctoPrint's
and Klipper's job, and they are good at it.

Still designed and not yet built: the printer fleet screen, a public intake
form, and the wall display.

## The one rule

**The AI reads the mess. The math stays deterministic.**

Language models are good at turning a rambling customer email and a photo of a
snapped bracket into a filled-in job form. They have no business producing a
number that lands on a document someone signs.

So the pricing engine is one tested module with no model anywhere near it, and
every figure traces back to a rate you set. AI features are optional, provider-
agnostic, and degrade to the manual form when nothing is configured. **Guma
never requires a GPU.**

## Wherever you are

Guma has no country baked into it. It reads your machine and gets out of the
way:

- **No timezone question.** Dates come from the operating system's clock, so
  "today" is the day your menu bar says it is. Nothing to set, nothing to keep
  in sync when a laptop crosses a border.
- **Your currency**, from the full ISO list, named in your own language. Your
  machine's region supplies the first guess; you can bill in something else.
- **Your number and date formats**, from the same place — including the
  arithmetic printed under each quote line, not just the money.
- **Your paper.** Quotes and closeout sheets lay out on A4 or Letter,
  whichever your region uses, overridable in Settings.
- **No US-only fields for non-US shops.** The one that exists — a state, used
  solely to name a US tax correctly — only appears if your machine says you
  are in the US.

Guma ships no tax rates for anywhere. The tax name and percentage are yours to
supply, because a rate compiled into an app goes stale and it is not this
project's call to make for your shop.

## Install

**The desktop app (recommended).** Grab the installer for your OS from the
[Releases page](https://github.com/cgai00742-sys/guma/releases) — no Node, no
terminal, no account of any kind. Double-click it, and the first launch runs
the setup wizard straight away: your shop, your currency, your tax, your
rates, your first machine. Everything lives in one file on your own computer
(currently: one install, one computer — no sync between machines yet).

These builds are unsigned for now — code-signing has a real recurring cost,
and that's a call worth making once real users are testing this, not before.
Expect one warning on first open: macOS will call it "from an unidentified
developer" (right-click → Open → Open); Windows may show a SmartScreen
warning ("More info" → "Run anyway").

**Running it in a browser instead**, self-hosted with your own Supabase
project. One thing to know before you choose this: **the desktop app is the
supported path for 1.0.** The browser build shares the same pricing engine and
the same screens, and its migrations ship in `supabase/migrations/`, but the
five migrations added in the 1.0 run (clients, payments, actuals, the build
sheet, drafts) have not yet been applied to a live Postgres by anyone. They are
written for parity and reviewed, not proven. If you want Guma today, download
the desktop app; if you want the browser build, expect to be the first person
to run those files and please open an issue when something is wrong with them.

With that said: click the green "Code" button above → "Download ZIP" → unzip
it, then:

- **Mac:** double-click `install.command`. If macOS says it is from an
  unidentified developer, right-click it → Open → Open — only needed once.
- **Windows:** double-click `install.bat`.

Either one checks for Node, installs Guma's dependencies, walks you through
creating a free Supabase project (that is Guma's database — yours alone, never
shared), and starts Guma at `http://localhost:5173`. Leave that window open
while you use Guma; closing it stops the shop.

Node itself is the one thing the installer cannot do for you — if you do not
have it, it will point you to https://nodejs.org (the free LTS version).

**The developer way**, if you'd rather drive it yourself:

```bash
git clone https://github.com/cgai00742-sys/guma.git && cd guma
npm install
cp .env.example .env        # your Supabase URL and publishable key
```

Run the files in `supabase/migrations/` in order in the Supabase SQL editor,
then:

```bash
npm run dev                 # http://localhost:5173
```

Sign in. The first account to sign in runs the setup wizard — your shop, your
currency, your tax, your rates, your first machine, your electricity rate.
Nothing is seeded for you, and nothing here is required to get started —
skip anything you're not ready to decide and fill it in later.

```bash
npm run build               # production bundle in dist/
```

`dist/` is a static site. Any static host serves it. (The full script list is
under **Layout**, below.)

## How the money works

The calculation order is load-bearing and easy to break by accident, so it is
written out once in `src/lib/pricing.ts` and enforced by tests:

1. the shop minimum applies to the raw subtotal, **before** rush and discount
2. rush is a percentage of that subtotal
3. discount is a percentage of (subtotal + rush)
4. tax applies **last**, to the discounted total
5. the deposit is a percentage of the **final total, tax included**, and is
   waived below a threshold you set

**Rates are versioned.** Saving the rates screen writes a new rate card rather
than editing the old one. Sending a quote freezes the whole rate set onto it, and
the PDF re-prices from that snapshot. Changing your rates can never move a
number on a quote a client is already holding.

## Layout

```
public/guma.css            the design system. Do not re-derive these tokens.
public/doc-page.js         the print engine. It owns all print geometry.
src/lib/pricing.ts         THE quote calculation. One copy, no second implementation.
src/lib/gates.ts           stage checklists and flags. Pure; the questions live
                           here, only the answers live in the database.
src/lib/actuals.ts         quoted against actual. Pure.
src/lib/dates.ts           calendar dates in the shop's timezone, never UTC.
src/lib/data.ts            picks a backend at runtime: local SQLite in the
                           desktop app, hosted Supabase in the browser.
                           Screens only ever import from here.
src/lib/data.local.ts      every database call, against the SQLite file the desktop app owns
src/lib/data.supabase.ts   every database call, against your hosted Supabase project
src/screens/               Setup · Intake · Projects (board + list) · Project ·
                           Clients · Settings · QuoteDoc · Closeout
                           (+ SignIn, browser build only)
src-tauri/migrations/      the desktop schema. A shipped migration is FROZEN —
                           see src/lib/migrations.test.ts.
supabase/migrations/       the same schema for the browser build
scripts/repair-migrations.mjs   `npm run db:repair`, for a database whose
                           migration checksums have drifted
```

Useful scripts:

```bash
npm test                   # 117 tests, including a full intake-to-delivered walk
npm run tauri dev          # the desktop app against live source
npm run db:repair          # fix a database that will not open after a schema change
npm run migrations:lock    # record a NEW migration's checksum
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version: no hard-coded rates,
no model in the pricing path, sign your commits with `git commit -s`.

## Licence

See [LICENSE](LICENSE).

<sub><em>Guma</em> is Chamoru for <em>house</em>.</sub>
