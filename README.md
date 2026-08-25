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

- **Live quoting.** Enter a job in front of the client and watch the price build
  line by line — design time, material, machine time, wear, finishing.
- **Cost and margin, for your eyes.** What the job costs *you*, with your own
  hours counted at the rate you charge, so margin means what's left after
  paying yourself.
- **A quote PDF** with your logo, the arithmetic behind every line, the deposit,
  your terms and a signature rule.
- **Rates that live in the database.** Every rate, markup, minimum, deposit
  percentage and tax figure is a row you edit in the app. None of them is a
  constant in the code.

Designed and still to build: the pipeline board, printer fleet, payments and
wall display.

## The one rule

**The AI reads the mess. The math stays deterministic.**

Language models are good at turning a rambling customer email and a photo of a
snapped bracket into a filled-in job form. They have no business producing a
number that lands on a document someone signs.

So the pricing engine is one tested module with no model anywhere near it, and
every figure traces back to a rate you set. AI features are optional, provider-
agnostic, and degrade to the manual form when nothing is configured. **Guma
never requires a GPU.**

## Install

You need Node 18+ and a Supabase project (the free tier is plenty).

```bash
git clone <this repo> && cd guma
npm install
cp .env.example .env        # your Supabase URL and publishable key
```

Run the files in `supabase/migrations/` in order in the Supabase SQL editor,
then:

```bash
npm run dev                 # http://localhost:5173
```

Sign in. The first account to sign in runs the setup wizard — your shop, your
currency, your tax, your rates, your first machine. Nothing is seeded for you.

```bash
npm test                    # the pricing tests
npm run build               # production bundle in dist/
```

`dist/` is a static site. Any static host serves it.

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
public/guma.css       the design system. Do not re-derive these tokens.
public/doc-page.js    the print engine. It owns all print geometry.
src/lib/pricing.ts    THE quote calculation. One copy, no second implementation.
src/lib/data.ts       every database call
src/screens/          SignIn · Setup · Settings · Intake · QuoteDoc
supabase/migrations/  schema, row-level security, the setup function
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version: no hard-coded rates,
no model in the pricing path, sign your commits with `git commit -s`.

## Licence

See [LICENSE](LICENSE).

<sub><em>Guma</em> is Chamoru for <em>house</em>.</sub>
