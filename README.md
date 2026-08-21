# Guma

Operations tool for the print shop. Live and in use.

| | |
|---|---|
| **Live site** | https://guma-8jn.pages.dev |
| **Cloudflare Pages project** | `guma` — note the project name is `guma`, the *subdomain* is `guma-8jn` |
| **Supabase project** | `lvizayqnnvvruajjjldn` · us-west-1 · free tier |
| **Sign in** | `cgai00742@gmail.com`, password. Magic link also works once SMTP is real. |

This build is the **"If you only get one day"** scope from the original
`DEPLOY.md`: Shop settings → Rates, Job intake & quote, and Send quote as PDF.

The pipeline board, printer fleet, payments and wall display are designed and in
the handoff package under `../design-package/`, but are deliberately not built —
they describe work that has to exist first.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # the pricing tests
npm run build
```

`.env` already holds the Supabase URL and publishable key.

## Ship a change

From this folder:

```bash
./deploy.sh
```

That builds and pushes to the live site. Or by hand:

```bash
npm run build
npx wrangler pages deploy dist --project-name guma --branch main
```

**`--project-name guma`, not `guma-8jn`.** `*.pages.dev` subdomains are globally
unique, so when `guma.pages.dev` was taken Cloudflare handed us
`guma-8jn.pages.dev` while keeping the project named `guma`. Pointing wrangler at
`guma-8jn` creates a second, empty project instead of deploying to this one.

`main` is the production branch. Deploy prints a hash-prefixed preview URL as
well; that is normal, the bare domain updates too.

## Shape

```
public/
  guma.css        the design system, linked as-is from index.html — do not
                  re-derive these tokens, and do not add a second styling system
  doc-page.js     the print engine. It owns ALL print geometry. There is no
                  @page rule and no print stylesheet anywhere in this repo
  brand/          the 16 production brand files, shipped as-is
  _headers        a year of immutable caching on /brand/*
  _redirects      SPA fallback. Without it a refresh on /settings 404s
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

Written out in `pricing.ts` and enforced by tests. Easy to break by accident:

1. the shop minimum applies to the raw subtotal, **before** rush and discount
2. rush is a percentage of that subtotal
3. discount is a percentage of (subtotal + rush)
4. tax applies **last**, to the discounted total
5. the deposit is a percentage of the **final total, tax included**, and is
   waived entirely below the threshold

## Still open

- **Shop details on the quote PDF are placeholders.** `Guma LLC · Maui, HI ·
  hello@guma.co · (808) 555-0142 · GE-XXXXXXX` prints on every quote a client
  signs. Fix in the Supabase SQL editor:

  ```sql
  update shops set
    legal_name = '…', address = '…', email = '…',
    phone = '…', license_no = '…'
  where slug = 'guma';
  ```

- **Email is on Supabase's built-in mailer**, which allows a couple of messages
  an hour and refuses any address outside the Supabase org. That is why password
  sign-in exists. **Shop staff cannot sign in at all until real SMTP is set up**
  (Resend or Postmark, at `/auth/smtp` in the Supabase dashboard).

- **Site URL / redirect allowlist** is still Supabase's default
  `http://localhost:3000`. Only affects magic links, not password sign-in. Fix at
  Authentication → URL Configuration: Site URL `https://guma-8jn.pages.dev`, and
  allow `https://guma-8jn.pages.dev/**`, `https://*.guma-8jn.pages.dev/**`,
  `http://localhost:5173/**`.

- **Rocket Loader** must be off if you attach a custom domain — it reorders
  scripts and breaks the quote PDF. It does not apply to `*.pages.dev`.

- **No card or online payment**, by decision. Cash, transfer, check, card in
  person, recorded by hand.
