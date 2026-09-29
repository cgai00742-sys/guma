/**
 * The questions Guma asks a new shop, in order, one at a time.
 *
 * This file is the WHOLE script. Not a form laid out in JSX with the
 * questions implied by field labels — the actual questions, in the actual
 * words, in one readable list, so that changing what Guma asks is an edit
 * here rather than an archaeology exercise across a 600-line screen.
 *
 * Three rules, all of them arrived at the hard way:
 *
 * PART 1 IS THE WHOLE WIZARD FOR MOST PEOPLE. Seven questions, and then it
 * stops and says so. They are exactly the answers Guma needs to cost a job
 * the shop does for itself — which is what a first project almost always
 * is. Everything else waits until there is a reason for it. Asking a shop
 * about deposit terms before they have logged a single print is asking for
 * a number they have not thought about yet, and a guessed number that looks
 * answered is worse here than a blank one.
 *
 * ONE DECISION PER SCREEN. A question may carry two fields when they are
 * genuinely one thought -- "what did it cost and how long will it last" is
 * one question that happens to need two boxes -- but never two unrelated
 * decisions. The way a setup screen overwhelms somebody is not by having
 * many steps, it is by putting nine fields on one of them.
 *
 * PART 2 BRANCHES. A shop selling at farmers' markets should never be asked
 * about rush surcharges, and a job shop should never be asked about Etsy's
 * cut. One question decides which half of the remaining questions exist.
 */

import type { ShopContext } from './data.types'

export type Answers = Record<string, string>

/** How this shop gets paid. Decides the second half of the wizard. */
export type Branch = 'clients' | 'selling' | 'both'

export interface Field {
  key: string
  label: string
  kind: 'text' | 'number' | 'money' | 'select'
  placeholder?: string
  options?: { value: string; label: string }[]
  /** Shown after the input: '/kWh', 'per kg', '%'. */
  suffix?: string
}

export interface Question {
  id: string
  part: 1 | 2
  /** The question itself, in the words a person would use. */
  ask: string
  /** One line on what it decides. Never two. */
  why: string
  /** One field, or two that are the same thought. */
  fields: Field[]
  /** Asked only when this is true of the answers so far. */
  when?: (a: Answers) => boolean
  /** Can be left blank and moved past. */
  optional?: boolean
}

const TECHS = [
  { value: 'fdm', label: 'FDM — filament' },
  { value: 'resin', label: 'Resin — MSLA / SLA' },
  { value: 'composite', label: 'Composite — continuous fiber' },
  { value: 'sls', label: 'SLS — powder' },
]

const sells = (a: Answers) => a.branch === 'selling' || a.branch === 'both'
const quotes = (a: Answers) => a.branch === 'clients' || a.branch === 'both'

export const QUESTIONS: Question[] = [
  /* ---- part one: enough to cost your own work ------------------------- */
  {
    id: 'name',
    part: 1,
    ask: 'What is your shop called?',
    why: 'The name at the top of everything you send out.',
    fields: [{ key: 'name', label: 'Shop name', kind: 'text', placeholder: 'Bay Street Fabrication' }],
  },
  {
    id: 'where',
    part: 1,
    ask: 'Where do you work from?',
    why: 'Sets your currency and page size, names your tax, and tells Guma what power costs where you are.',
    fields: [
      { key: 'address', label: 'Town or address', kind: 'text', placeholder: 'Hilo, HI' },
      { key: 'state', label: 'State', kind: 'select' },
    ],
  },
  {
    id: 'power',
    part: 1,
    ask: 'What do you pay for electricity?',
    why: 'Without it Guma prices machine time at break-even, and every margin you see is a floor rather than a figure.',
    fields: [{ key: 'kwh', label: 'Per kilowatt-hour', kind: 'money', placeholder: 'from your bill' }],
  },
  {
    id: 'machine',
    part: 1,
    ask: 'What is your first machine?',
    why: 'Print runs get logged against a machine, so there has to be one before anything can be recorded.',
    fields: [
      { key: 'pName', label: 'What you call it', kind: 'text', placeholder: 'Bay 1' },
      { key: 'pTech', label: 'Technology', kind: 'select', options: TECHS },
    ],
  },
  {
    id: 'wear',
    part: 1,
    ask: 'What did it cost, and how many print hours do you expect out of it?',
    why: 'Guma turns those two into wear per hour. Guessing long on the life is the same mistake as guessing low on the wear.',
    fields: [
      { key: 'pPrice', label: 'What it cost', kind: 'money' },
      { key: 'pLife', label: 'Print hours you expect', kind: 'number', placeholder: '5000' },
    ],
  },
  {
    id: 'material',
    part: 1,
    ask: 'What do you print with most, and what does a kilo cost you?',
    why: 'The material line on every job, and what a failed print actually costs you.',
    fields: [
      { key: 'mName', label: 'Material', kind: 'text', placeholder: 'PLA' },
      { key: 'mPerKg', label: 'What a kilo costs', kind: 'money' },
    ],
  },
  {
    id: 'rate',
    part: 1,
    ask: 'What is an hour of your time worth?',
    why: 'The biggest line on most jobs, and the one shops most often leave out of their own work.',
    fields: [{ key: 'designHourly', label: 'Design and modeling, per hour', kind: 'money' }],
  },

  /* ---- the fork ------------------------------------------------------- */
  {
    id: 'branch',
    part: 2,
    ask: 'How do you mostly get paid?',
    why: 'So Guma only asks about the half of this that applies to you.',
    fields: [
      {
        key: 'branch',
        label: 'Mostly',
        kind: 'select',
        options: [
          { value: 'clients', label: 'Someone asks, I price it, they pay' },
          { value: 'selling', label: 'I make things and sell them' },
          { value: 'both', label: 'Both' },
        ],
      },
    ],
  },

  /* ---- part two, asked of everyone ------------------------------------ */
  {
    id: 'watts',
    part: 2,
    ask: 'How much power does that machine draw while printing?',
    why: 'Off the spec sheet. With your rate above, this is what turns machine time from an estimate into a cost.',
    fields: [{ key: 'pWatts', label: 'Watts', kind: 'number', placeholder: '350' }],
    optional: true,
  },
  {
    id: 'finishing',
    part: 2,
    ask: 'What is an hour of hands-on finishing worth?',
    why: 'Support removal, sanding, wash and cure. Usually below your design rate, because it is hands rather than judgment.',
    fields: [{ key: 'finishingHourly', label: 'Finishing, per hour', kind: 'money' }],
    optional: true,
  },
  {
    id: 'tax',
    part: 2,
    ask: 'What is your tax called, and what rate?',
    why: 'It goes on what you charge. Getting the name right matters as much as the number on anything a client keeps.',
    fields: [
      { key: 'taxLabel', label: 'Called', kind: 'text', placeholder: 'Sales tax' },
      { key: 'taxPct', label: 'Rate', kind: 'number', suffix: '%' },
    ],
    optional: true,
  },

  /* ---- part two, for shops quoting clients ---------------------------- */
  {
    // The setup checklist has always wanted an email or phone before it
    // calls a quoting shop "set up" -- a quote with no way to reply to it --
    // and no question ever asked for one. So a shop could answer every
    // question here and still be told setup was unfinished, with nowhere
    // in setup to finish it.
    id: 'contact',
    part: 2,
    ask: 'How do clients reach you?',
    why: 'It goes on every quote. A quote with no way to reply to it is a quote that does not come back.',
    fields: [
      { key: 'email', label: 'Email', kind: 'text', placeholder: 'you@yourshop.com' },
      { key: 'phone', label: 'Phone', kind: 'text', placeholder: '(808) 555-0100' },
    ],
    when: quotes,
    optional: true,
  },
  {
    id: 'deposit',
    part: 2,
    ask: 'What do you take up front?',
    why: 'You buy material and spend hours before you see anything. Half is the long-standing norm across build-to-order trades.',
    fields: [{ key: 'depositPct', label: 'Deposit', kind: 'number', suffix: '%' }],
    when: quotes,
    optional: true,
  },
  {
    id: 'minimum',
    part: 2,
    ask: 'What is the smallest job you will take?',
    why: 'The setup conversation costs the same on a small job as a large one. A minimum is what stops the small ones eating the week.',
    fields: [{ key: 'minimumOrder', label: 'Shop minimum', kind: 'money' }],
    when: quotes,
    optional: true,
  },
  {
    id: 'markup',
    part: 2,
    ask: 'What do you sell material at?',
    why: 'A multiplier on what it costs you. At 1x you are selling filament at cost.',
    fields: [{ key: 'markup', label: 'Cost times', kind: 'number', suffix: '×' }],
    when: quotes,
    optional: true,
  },

  /* ---- part two, for shops selling what they make --------------------- */
  {
    id: 'channels',
    part: 2,
    ask: 'Where do you sell?',
    why: 'Each place takes a different cut, and the cut is the part most shops never subtract from the profit.',
    fields: [{ key: 'channels', label: 'Pick all that apply', kind: 'select' }],
    when: sells,
    optional: true,
  },
]

/**
 * The questions that apply, in order, given what has been answered.
 *
 * Branch questions vanish rather than grey out: a shop that sells at
 * markets should never see a rush-surcharge field at all, not see one it is
 * told to ignore.
 */
export function questionsFor(answers: Answers): Question[] {
  return QUESTIONS.filter((q) => !q.when || q.when(answers))
}

/** Just part one -- the set that ends with "that is enough, go log a job". */
export function partOne(): Question[] {
  return QUESTIONS.filter((q) => q.part === 1)
}

/** True once every part-one question has a usable answer. */
export function partOneDone(answers: Answers): boolean {
  return partOne().every((q) => q.fields.every((f) => (answers[f.key] ?? '').trim() !== ''))
}

/**
 * What the app genuinely cannot work without -- the gate that opens setup
 * at launch.
 *
 * Deliberately narrower than partOneDone. Where the shop is (a US state in
 * particular) shapes hints, not arithmetic: a shop in Berlin has no state,
 * and requiring one held it in the wizard forever. The gate asks only for
 * what every price is built from -- a name, what power costs, a machine and
 * its wear, a material and its cost, and what an hour is worth.
 */
export function essentialsDone(answers: Answers): boolean {
  const has = (k: string) => (answers[k] ?? '').trim() !== ''
  return (
    has('name') &&
    has('kwh') &&
    has('pName') &&
    has('pPrice') &&
    has('pLife') &&
    has('mName') &&
    has('mPerKg') &&
    has('designHourly')
  )
}

/** Where to resume: the first unanswered question that applies. */
export function firstUnanswered(answers: Answers): Question | null {
  return (
    questionsFor(answers).find(
      (q) => !q.optional && q.fields.some((f) => (answers[f.key] ?? '').trim() === ''),
    ) ?? null
  )
}

/**
 * What this shop has already told Guma, as wizard answers.
 *
 * The wizard is re-enterable, so it has to start from the truth rather than
 * from blank fields -- somebody coming back in week six should find their
 * machine already named, not be asked to name it again. Reading the shop
 * back into answers is what makes "resume" and "first run" the same code
 * path instead of two that drift.
 */
export function answersFrom(ctx: ShopContext): Answers {
  const shop = ctx.shop as unknown as Record<string, unknown>
  const rc = ctx.rateCard as unknown as Record<string, unknown>
  const printer = ctx.printerRows.find((p) => !p.archived)
  const material = ctx.materials[0]

  const str = (v: unknown) => (v == null || v === '' ? '' : String(v))
  // A stored zero is a real answer for a percentage and a non-answer for a
  // rate. Rates that read zero come back blank so the wizard asks again.
  const rate = (v: unknown) => (Number(v) > 0 ? String(v) : '')

  return {
    name: str(shop.name),
    address: str(shop.address),
    state: str(shop.state),
    kwh: str(shop.electricity_rate_kwh),
    pName: str(printer?.name),
    pTech: str(printer?.tech),
    pWatts: str(printer?.watts),
    // Wear is stored as an answer; the two questions behind it are not, so
    // a shop with a wear rate on file is not asked to re-derive it.
    pPrice: Number(printer?.wear_hourly) > 0 ? 'on file' : '',
    pLife: Number(printer?.wear_hourly) > 0 ? 'on file' : '',
    mName: str(material?.name),
    mPerKg: Number(material?.costPerUnit) > 0 ? String(Number(material!.costPerUnit) * 1000) : '',
    designHourly: rate(rc.design_hourly),
    finishingHourly: rate(rc.finishing_hourly),
    email: str(shop.email),
    phone: str(shop.phone),
    taxLabel: str(shop.tax_label),
    // Zero is a real tax rate once the tax has a name (see setupPlan).
    taxPct: str(shop.tax_label) ? String(Number(shop.tax_pct ?? 0)) : '',
    depositPct: rate(rc.deposit_pct),
    minimumOrder: rate(rc.minimum_order),
    markup: Number(rc.material_markup) > 1 ? String(rc.material_markup) : '',
    // Stored since 0023. Before that the answer was thrown away, so every
    // return to setup opened on this question again.
    branch: str(shop.sell_branch),
    channels: '',
  }
}
