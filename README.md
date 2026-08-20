# Guma

Print-shop operations. This build is the **"If you only get one day"** scope from
`DEPLOY.md`: Shop settings → Rates, Job intake & quote, and Send quote as PDF.

The pipeline board, printer fleet, payments and wall display are designed and in
the handoff package, but are deliberately not built yet — they describe work that
has to exist first.

## Run it

```bash
npm install
cp .env.example .env      # fill in the Supabase URL and publishable key
npm run dev               # http://localhost:5173
npm test                  # the pricing tests
npm run build
```

## Shape

```
public/
  guma.css        the design system, linked as-is from index.html — do not
                  re-derive these tokens, and do not add a second styling system
  doc-page.js     the print engine. It owns ALL print geometry. There is no
                  @page rule and no print stylesheet anywhere in this repo
  brand/          the 16 production brand files, shipped as-is
  _headers        Cloudflare Pages: a year of immutable caching on /brand/*
src/
  lib/pricing.ts       THE quote calculation. One copy, no second implementation
  lib/pricing.test.ts  23 tests, including the fully worked example off the
                       Quote PDF design file
  lib/data.ts          every Supabase call
  screens/             SignIn · Settings · Intake · QuoteDoc
```

## The rules this codebase holds

**No hard-coded rates.** Every rate, the material markup, the deposit percentage,
the shop minimum and the tax rate are rows in `rate_cards` / `materials` /
`shops`. `pricing.ts` takes all of them as arguments and contains no pricing
constant of any kind. Moving a rate is a database write, never a deploy.

**Rates are versioned.** Saving the Rates tab **inserts a new `rate_cards` row**
rather than updating the current one. Sending a quote freezes the whole rate set
— plus the material and machine it used — onto `quotes.rates_snapshot`, and the
PDF re-prices from that snapshot, never from today's rates. A rate change cannot
move a number on a quote a client already holds.

**Derive, don't store, money state.** Payments are append-only rows; owed amounts
come from the `job_money` view. There is no `payment_status` column.

**Inline styles or `guma.css` classes only.** No Tailwind, no second system.

**The two registers.** The topbar and sign-in may glow. The settings screen and
the quote screen are flat and calm: the only lit element on either is one
`--lit-edge` border, and the only `--biolum` is the live total. `--biolum` is
never written to the database and has no override column.

## Calculation order

Written out in `pricing.ts` and enforced by tests. It is easy to break by
accident:

1. the shop minimum applies to the raw subtotal, **before** rush and discount
2. rush is a percentage of that subtotal
3. discount is a percentage of (subtotal + rush)
4. tax applies **last**, to the discounted total
5. the deposit is a percentage of the **final total, tax included**, and is
   waived entirely below the threshold

## Deploy

Two things that waste an afternoon if skipped:

- **Cloudflare → Speed → Optimization → Rocket Loader OFF.** It defers and
  reorders scripts and breaks anything reading the DOM on load.
- **Supabase → Authentication → URL Configuration.** Set Site URL to the
  production domain and add every preview pattern plus `http://localhost:5173`
  to the redirect allowlist, or every magic link goes to localhost.

Then: Pages project from this repo, build `npm run build`, output `dist`,
`_headers` already at the project root. `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` as Pages env vars, **production and preview
separately**. The service-role key never reaches the client.
