# Contributing to Guma

Guma is a quoting and costing tool for small 3D-print shops. It is built by
people who run one.

## The rule that matters most

**The pricing engine is deterministic and stays that way.**

`src/lib/pricing.ts` is the only place the quote arithmetic exists. It takes
every rate as an argument and contains no pricing constant of any kind. A
number that ends up on a document a client signs must be traceable to a rate
the shop set.

AI features are welcome — reading a messy enquiry, extracting specs from a
file, triaging RFQs. **A model must never produce a price, a markup, a deposit
or a tax figure.** A pull request that puts a model in the pricing path will be
declined however good it is.

Every change to `pricing.ts` needs a test. The suite reproduces a fully worked
quote to the cent; if your change breaks it, the change is wrong until proven
otherwise.

## Other house rules

- **No hard-coded rates, currencies or jurisdictions.** If you find yourself
  typing `$` or a tax rate, it belongs in the database and the setup wizard.
- **Styling is `guma.css` classes or inline styles.** No Tailwind, no second
  design system. `public/guma.css` is the source of truth for tokens.
- **The two registers.** Sign-in, the top bar and a wall display may glow.
  Screens someone sits in front of for six hours stay flat: no gradients, no
  glow except on genuinely live values.
- **No GPU may ever be required.** Every AI feature degrades to the manual form
  it replaces when no provider is configured.
- **Money state is derived, not stored.** Payments are append-only rows; owed
  amounts come from the `job_money` view.

## Getting set up

```bash
npm install
npm test
```

From there it depends which build you're working on — `src/lib/data.ts`
picks one of two backends at runtime (see its own comment), and most
contributions only touch one side of that split:

**Working on the desktop app** (`src-tauri/`, `src/lib/data.local.ts`, or
anything that doesn't care which backend is active): no account needed.

```bash
npm run desktop:dev      # opens the native app window, SQLite backend
```

**Working on the hosted/browser build** (`src/lib/data.supabase.ts`,
`src/screens/SignIn.tsx`, or Supabase-specific behavior): you need your own
Supabase project.

```bash
cp .env.example .env     # point at your own Supabase project
```

Run the files in `supabase/migrations/` in order, then:

```bash
npm run dev               # http://localhost:5173, sign in to run the setup wizard
```

If your change touches `src/lib/data.local.ts`, see `src/lib/data.local.test.ts`
— it runs the real SQL against a real SQLite engine (Node's built-in
`node:sqlite`) rather than mocking the database, which is worth matching for
new backend code rather than trusting that a query is correct because it
looks right.

## Sign-off

Commits need a Developer Certificate of Origin sign-off, which is one line:

```bash
git commit -s -m "your message"
```

That appends `Signed-off-by: Your Name <you@example.com>` and means you have
the right to submit the work under the project's licence. There is no CLA and
no copyright assignment.

## Before you open a pull request

- `npm test` passes
- `npm run build` passes
- You have described what a shop can now do that it could not do before

Small, sharp pull requests get read quickly. Large ones sit.

## Reporting something broken

Include what you expected, what happened, and — if it involves a quote — the
inputs and the number you got. Never paste real client details into an issue.
