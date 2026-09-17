/**
 * Setting a shop up, one question at a time.
 *
 * The script lives in src/lib/wizard.ts. This file only renders it, which
 * is the point: what Guma asks should be editable without reading a screen
 * component, and the order should be a list rather than a control flow.
 *
 * WHY THIS REPLACED THE OLD SETUP. The three-step wizard created a shop row
 * and stopped, leaving most of what decides a margin blank, and there was
 * no way back into it -- setup that exists only before the shop does. The
 * program then looked like it was working, because quotes came out and
 * totals added up, while pricing machine time at break-even.
 *
 * THE SHOP IS CREATED ON THE FIRST ANSWER. Not at the end. Somebody who
 * names their shop and closes the window has a shop called that, and comes
 * back to question two. The old version assembled one payload at the end,
 * so quitting early lost everything -- which is the failure mode of every
 * long form ever written.
 *
 * NOTHING IS PRE-FILLED WITH A GUESS. Suggestions appear BESIDE the box --
 * the state's published power rate, the wear per hour implied by what the
 * machine cost -- with a button that fills it. Accepting your own division
 * is not accepting a recommendation, and a field left blank is a question
 * still open rather than an answer nobody checked.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createInHouseJob,
  saveMaterial,
  savePrinter,
  saveRateCard,
  saveShopIdentity,
  saveShopQuoteTerms,
  setupShop,
  type ShopContext,
} from '../lib/data'
import {
  answersFrom,
  questionsFor,
  partOne,
  partOneDone,
  type Answers,
  type Field,
  type Question,
} from '../lib/wizard'
import { makeMoney } from '../lib/pricing'
import { currencySymbol, osCurrency, osLocale, regionOf } from '../lib/locale'
import { powerRateFor, US_AVERAGE_CENTS } from '../lib/power'
import { wearPerHour, rateImplies } from '../lib/derive'
import { US_STATES, taxHintFor } from '../lib/taxHelp'
import { benchmarksFor } from '../lib/benchmarks'
import FieldGuide, { benchmarkGroup, makeBenchmarkFormatter, type GuideGroup } from '../components/FieldGuide'

const CHANNELS = [
  { value: 'etsy', label: 'Etsy' },
  { value: 'market', label: 'Markets and fairs' },
  { value: 'direct', label: 'Direct / word of mouth' },
  { value: 'site', label: 'My own site' },
  { value: 'wholesale', label: 'Wholesale' },
]

const num = (v: string) => (v.trim() === '' ? 0 : Number(v))
const orNull = (v: string) => (v.trim() === '' ? null : Number(v))

export default function Wizard({
  ctx,
  fullName,
  onSaved,
  onDefer,
}: {
  /** Null on a brand-new install: the shop does not exist yet. */
  ctx: ShopContext | null
  fullName: string
  onSaved: () => void
  /** Leaving without finishing. Absent when there is no app to fall back to. */
  onDefer?: () => void
}) {
  const navigate = useNavigate()
  const [answers, setAnswers] = useState<Answers>(() => (ctx ? answersFrom(ctx) : {}))
  const [at, setAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shopId, setShopId] = useState<string | null>(ctx?.shop.id ?? null)
  const [finished, setFinished] = useState(false)

  // Resume where the shop actually left off, once, on entry.
  useEffect(() => {
    if (!ctx) return
    const list = questionsFor(answersFrom(ctx))
    const idx = list.findIndex(
      (q) => !q.optional && q.fields.some((f) => (answersFrom(ctx)[f.key] ?? '').trim() === ''),
    )
    setAt(idx === -1 ? 0 : idx)
    // Deliberately only on mount: re-running this while somebody is typing
    // would yank them back to an earlier question mid-answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const list = useMemo(() => questionsFor(answers), [answers])
  const q: Question | undefined = list[at]

  const currency = ctx?.shop.currency || osCurrency()
  const locale = ctx?.shop.locale || osLocale()
  const { money } = useMemo(() => makeMoney(currency, locale), [currency, locale])
  const fmtBench = useMemo(() => makeBenchmarkFormatter(money), [money])
  const sym = currencySymbol(currency, locale) || ''
  const isUS = useMemo(() => regionOf(osLocale()) === 'US', [])

  const set = (key: string, v: string) => setAnswers((a) => ({ ...a, [key]: v }))
  const val = (key: string) => answers[key] ?? ''

  const answered = q ? q.fields.every((f) => val(f.key).trim() !== '') : false
  const canGo = answered || !!q?.optional

  /* ---- what Guma can work out from the answer on screen ---------------- */
  const statePower = powerRateFor(val('state'))
  const wear = wearPerHour({ price: val('pPrice'), lifetimeHours: val('pLife') })
  const implied = rateImplies(val('designHourly'))
  const taxHint = useMemo(() => taxHintFor(val('state')), [answers.state])

  function guideFor(id: string): (GuideGroup | null | false)[] {
    switch (id) {
      case 'power':
        return [
          statePower && {
            tag: 'Published',
            rows: [
              { label: `${val('state')}, commercial average`, value: `${sym}${statePower.perKwh.toFixed(4)}` },
              { label: 'US average', value: `${sym}${(US_AVERAGE_CENTS / 100).toFixed(4)}` },
            ],
            note:
              statePower.timesAverage >= 1.5
                ? `Power there runs about ${statePower.timesAverage.toFixed(1)}× the national average, so a guess would be an expensive one.`
                : 'An average, not your bill. Replace it when you have one to hand.',
            cite: `${statePower.sourceShort} ${statePower.asOf}`,
            action: { label: `Use ${statePower.perKwh.toFixed(4)}`, onClick: () => set('kwh', statePower.perKwh.toFixed(4)) },
          },
        ]
      case 'wear':
        return [
          wear && {
            tag: 'Yours',
            own: true,
            rows: [{ label: 'Wear per hour', value: money(wear.perHour) }],
            note: 'What it cost, divided by the hours you expect out of it.',
          },
          benchmarkGroup(benchmarksFor('wearHourly', currency), fmtBench),
        ]
      case 'material':
        return [benchmarkGroup(benchmarksFor('materialPerKg', currency), fmtBench)]
      case 'rate':
        return [
          implied && {
            tag: 'Yours',
            own: true,
            rows: [
              { label: `A day (${implied.dayHours} h)`, value: money(implied.perDay) },
              { label: `A year (${implied.billableHoursPerWeek} billable h/wk)`, value: money(implied.perYear) },
            ],
          },
          benchmarkGroup(benchmarksFor('designHourly', currency), fmtBench),
        ]
      case 'finishing':
        return [
          num(val('designHourly')) > 0 && {
            tag: 'Yours',
            own: true,
            rows: [{ label: '70% of your design rate', value: money(num(val('designHourly')) * 0.7) }],
            note: 'Where most shops start.',
            action: {
              label: 'Use it',
              onClick: () => set('finishingHourly', String(Math.round(num(val('designHourly')) * 0.7 * 100) / 100)),
            },
          },
        ]
      case 'tax':
        return [
          taxHint && {
            tag: val('state'),
            own: true,
            rows: [],
            note: taxHint.note,
            action: { label: `Call it “${taxHint.label}”`, onClick: () => set('taxLabel', taxHint.label) },
          },
        ]
      case 'deposit':
        return [benchmarkGroup(benchmarksFor('depositPct', currency), fmtBench)]
      case 'minimum':
        return [benchmarkGroup(benchmarksFor('minimumOrder', currency), fmtBench)]
      case 'markup':
        return [benchmarkGroup(benchmarksFor('markup', currency), fmtBench)]
      default:
        return []
    }
  }

  /* ---- saving ---------------------------------------------------------- */

  /** Create the shop the moment it has a name, so nothing after this is
   *  lost by closing the window. */
  async function ensureShop(): Promise<string> {
    if (shopId) return shopId
    const id = await setupShop({
      shop: { name: val('name').trim(), currency, locale },
      rates: {},
      printer: null,
      materials: [],
      fullName,
    })
    setShopId(id)
    return id
  }

  async function saveCurrent(): Promise<void> {
    if (!q) return
    const id = await ensureShop()
    const shop = ctx?.shop

    if (q.id === 'where' || q.id === 'power' || q.id === 'name') {
      await saveShopIdentity(id, {
        name: val('name').trim() || shop?.name || 'My shop',
        legal_name: shop?.legal_name ?? '',
        address: val('address').trim(),
        state: val('state'),
        email: shop?.email ?? '',
        phone: shop?.phone ?? '',
        license_no: shop?.license_no ?? '',
        electricity_rate_kwh: orNull(val('kwh')),
        currency,
        locale,
        paper: shop?.paper ?? '',
      } as never)
    }

    if (q.id === 'machine' || q.id === 'wear' || q.id === 'watts') {
      const existing = ctx?.printerRows.find((p) => !p.archived)
      await savePrinter(id, {
        id: existing?.id ?? null,
        name: val('pName').trim() || existing?.name || 'Bay 1',
        model: existing?.model ?? '',
        tech: val('pTech') || existing?.tech || 'fdm',
        rate_hourly: Number(existing?.rate_hourly ?? 0),
        wear_hourly: wear ? Math.round(wear.perHour * 10000) / 10000 : Number(existing?.wear_hourly ?? 0),
        watts: orNull(val('pWatts')) ?? existing?.watts ?? null,
      } as never)
    }

    if (q.id === 'material' && num(val('mPerKg')) > 0) {
      const existing = ctx?.materials[0]
      await saveMaterial(id, {
        id: existing?.id ?? null,
        name: val('mName').trim() || 'PLA',
        kind: val('mName').trim() || 'PLA',
        swatch: '#5A6B7C',
        unit: 'g',
        cost_per_unit: num(val('mPerKg')) / 1000,
        sell_override: null,
      } as never)
    }

    if (['rate', 'finishing', 'deposit', 'minimum', 'markup'].includes(q.id) && ctx) {
      await saveRateCard(id, {
        ...ctx.rateCard,
        design_hourly: num(val('designHourly')) || Number(ctx.rateCard.design_hourly),
        finishing_hourly: num(val('finishingHourly')) || Number(ctx.rateCard.finishing_hourly),
        deposit_pct: num(val('depositPct')) || Number(ctx.rateCard.deposit_pct),
        minimum_order: num(val('minimumOrder')) || Number(ctx.rateCard.minimum_order),
        material_markup: num(val('markup')) || Number(ctx.rateCard.material_markup),
      } as never)
    }

    if (q.id === 'tax' && ctx) {
      await saveShopQuoteTerms(id, {
        tax_label: val('taxLabel').trim() || ctx.shop.tax_label,
        tax_pct: num(val('taxPct')),
        quote_valid_days: Number(ctx.shop.quote_valid_days ?? 30),
        lead_days: Number(ctx.shop.lead_days ?? 10),
        terms_text: ctx.shop.terms_text ?? '',
        revision_policy: ctx.shop.revision_policy ?? '',
        payment_info: (ctx.shop as never as { payment_info?: string }).payment_info ?? '',
      })
    }

    onSaved()
  }

  async function next() {
    setBusy(true)
    setError(null)
    try {
      await saveCurrent()
      // Part one ends with a landing, not with question eight.
      if (partOneDone(answers) && q && q.id === partOne()[partOne().length - 1].id) {
        setFinished(true)
      } else if (at < list.length - 1) {
        setAt(at + 1)
      } else {
        setFinished(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function startFirstJob() {
    if (!shopId) return
    setBusy(true)
    try {
      const jobId = await createInHouseJob(shopId, { title: 'First job', brief: null })
      onSaved()
      navigate(`/project/${jobId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  /* ---- the landing between part one and part two ----------------------- */
  if (finished) {
    const inPartTwo = list.some((x) => x.part === 2)
    return (
      <div className="wrap" style={{ paddingTop: 48, maxWidth: 560 }}>
        <div className="pane">
          <h2 style={{ marginBottom: 4 }}>That is enough to start.</h2>
          <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--txt-2)', marginTop: 8 }}>
            Guma can now tell you what a job costs you — material, machine, wear and your own
            hours. Log something you are working on and it will show you the number.
          </div>
          {error && <div className="alert" style={{ marginTop: 12 }}><span>{error}</span></div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button type="button" className="btn primary" onClick={startFirstJob} disabled={busy}>
              {busy ? 'Starting…' : 'Log my first job'}
            </button>
            {inPartTwo && (
              <button type="button" className="btn" onClick={() => { setFinished(false); setAt(partOne().length) }} disabled={busy}>
                Keep setting up
              </button>
            )}
            {onDefer && (
              <button type="button" className="btn ghost" onClick={onDefer} disabled={busy} style={{ marginLeft: 'auto' }}>
                Just look around
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!q) return null

  const partOneCount = partOne().length
  const stepLabel =
    q.part === 1 ? `${at + 1} of ${partOneCount}` : `${at + 1 - partOneCount} of ${list.length - partOneCount}`

  return (
    <div className="wrap" style={{ paddingTop: 36, paddingBottom: 48, maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 18 }}>
        <span className="guide-tag">{q.part === 1 ? 'Setting up' : 'A bit more'}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)' }}>
          {stepLabel}
        </span>
        {onDefer && (
          <button type="button" className="addnote" style={{ marginLeft: 'auto' }} onClick={onDefer}>
            finish later
          </button>
        )}
      </div>

      <h2 style={{ fontSize: 22, lineHeight: '29px', marginBottom: 6 }}>{q.ask}</h2>
      <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--txt-2)', maxWidth: 620 }}>
        {q.why}
      </div>

      {error && <div className="alert" style={{ marginTop: 14 }}><span>{error}</span></div>}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) 300px',
          gap: 20,
          alignItems: 'start',
          marginTop: 20,
        }}
      >
        <div>
          <div className={q.fields.length > 1 ? 'grid2' : ''} style={{ maxWidth: q.fields.length > 1 ? undefined : 340 }}>
            {q.fields.map((f, i) => (
              <QuestionField
                key={f.key}
                field={f}
                value={val(f.key)}
                onChange={(v) => set(f.key, v)}
                autoFocus={i === 0}
                isUS={isUS}
                sym={sym}
              />
            ))}
          </div>

          <FieldGuide groups={guideFor(q.id)} />

          <div style={{ display: 'flex', gap: 8, marginTop: 22, alignItems: 'center' }}>
            {at > 0 && (
              <button type="button" className="btn" onClick={() => setAt(at - 1)} disabled={busy}>
                Back
              </button>
            )}
            <button
              type="button"
              className="btn primary"
              onClick={next}
              disabled={busy || !canGo}
              style={{ marginLeft: 'auto' }}
            >
              {busy ? 'Saving…' : answered ? 'Next' : q.optional ? 'Skip' : 'Next'}
            </button>
          </div>
        </div>

        <div className="pane" style={{ margin: 0 }}>
          <div className="k" style={{ fontSize: 11 }}>Where you are</div>
          <div className="guide" style={{ marginTop: 8 }}>
            {partOne().map((x, i) => (
              <div className="guide-g" key={x.id}>
                <div className="guide-h">
                  <span className={i === at ? 'guide-tag' : 'guide-tag alt'}>
                    {x.fields.every((f) => val(f.key).trim() !== '') ? 'Done' : i === at ? 'Now' : '—'}
                  </span>
                  <span className="guide-note" style={{ marginTop: 0 }}>{x.ask.replace(/\?$/, '')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** One input. The only place the question script meets an HTML control. */
function QuestionField({
  field,
  value,
  onChange,
  autoFocus,
  isUS,
  sym,
}: {
  field: Field
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  isUS: boolean
  sym: string
}) {
  const id = `w-${field.key}`

  // The state list and the channel list are data the script should not have
  // to carry, so they are resolved here by key.
  if (field.key === 'state') {
    if (!isUS) return null
    return (
      <div className="fld">
        <label className="lbl" htmlFor={id}>{field.label}</label>
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— pick one —</option>
          {US_STATES.map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.key === 'channels') {
    const picked = new Set(value.split(',').filter(Boolean))
    return (
      <div className="fld">
        <label className="lbl">{field.label}</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {CHANNELS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`btn sm${picked.has(c.value) ? ' primary' : ''}`}
              onClick={() => {
                const next = new Set(picked)
                if (next.has(c.value)) next.delete(c.value)
                else next.add(c.value)
                onChange([...next].join(','))
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="hint">
          Each one takes a different cut. Guma will ask what, and subtract it from what you keep.
        </div>
      </div>
    )
  }

  if (field.kind === 'select') {
    return (
      <div className="fld">
        <label className="lbl" htmlFor={id}>{field.label}</label>
        <select id={id} autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— pick one —</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div className="fld">
      <label className="lbl" htmlFor={id}>
        {field.label}
        {field.kind === 'money' && sym ? ` (${sym})` : ''}
        {field.suffix ? ` (${field.suffix})` : ''}
      </label>
      <input
        id={id}
        autoFocus={autoFocus}
        type={field.kind === 'text' ? 'text' : 'number'}
        inputMode={field.kind === 'text' ? undefined : 'decimal'}
        min={field.kind === 'text' ? undefined : '0'}
        step="any"
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
