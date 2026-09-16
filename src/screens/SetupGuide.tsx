/**
 * Setting the shop up, with the program doing the walking.
 *
 * Guma's original setup asked three steps and then handed over the whole
 * application. Everything that decides a margin — what power costs, what a
 * machine wears out at, what material costs, what an hour of your own time
 * is worth — was either skipped or buried in a settings screen nobody had a
 * reason to open. The program looked like it was working, because quotes
 * came out and totals added up, while quietly reporting break-even machine
 * time and free material.
 *
 * So this is not a first-run gate. It is a place you can come back to, that
 * knows what is already answered, tells you what each gap is costing, and
 * takes one thing at a time. See src/lib/setupPlan.ts for the rules about
 * what counts as done and which gaps actually distort a number.
 *
 * ONE DECISION PER SCREEN. The instruction that shaped this was "do not
 * confuse the user with too many options", and the way a setup screen
 * breaks that rule is not by having too many steps — it is by putting nine
 * unrelated fields on one of them. Each section here asks about one thing,
 * says what it decides, and shows what it just changed.
 *
 * SAVES AS IT GOES. Every section writes when you leave it, so a setup
 * abandoned half way is a shop configured half way rather than nothing at
 * all. The old wizard assembled one payload at the end, which meant closing
 * the window lost everything.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  saveMaterial,
  savePrinter,
  saveRateCard,
  saveShopIdentity,
  saveShopQuoteTerms,
  type ShopContext,
} from '../lib/data'
import { planFor, type SectionId } from '../lib/setupPlan'
import { makeMoney } from '../lib/pricing'
import { currencySymbol, osCurrency, osLocale } from '../lib/locale'
import { powerRateFor, US_AVERAGE_CENTS } from '../lib/power'
import { wearPerHour, rateImplies } from '../lib/derive'
import { US_STATES, taxHintFor } from '../lib/taxHelp'
import FieldGuide, { benchmarkGroup, makeBenchmarkFormatter } from '../components/FieldGuide'
import { benchmarksFor } from '../lib/benchmarks'

const num = (v: string) => (v.trim() === '' ? 0 : Number(v))
const orNull = (v: string) => (v.trim() === '' ? null : Number(v))

export default function SetupGuide({
  ctx,
  onSaved,
  onDefer,
}: {
  ctx: ShopContext
  onSaved: () => void
  /** Provided when the guide is the front door on launch: leaving means
   *  falling through to the rest of the app, not navigating. */
  onDefer?: () => void
}) {
  const navigate = useNavigate()
  const leave = () => (onDefer ? onDefer() : navigate('/projects'))
  const plan = useMemo(
    () =>
      planFor({
        shop: ctx.shop,
        rateCard: ctx.rateCard,
        printerRows: ctx.printerRows,
        materials: ctx.materials as never,
      }),
    [ctx],
  )

  // Start on the first thing that is not done, so returning to this screen
  // resumes rather than restarts.
  const [at, setAt] = useState<SectionId>(plan.remaining[0]?.id ?? 'identity')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currency = ctx.shop.currency || osCurrency()
  const locale = ctx.shop.locale || osLocale()
  const { money } = useMemo(() => makeMoney(currency, locale), [currency, locale])
  const fmtBench = useMemo(() => makeBenchmarkFormatter(money), [money])
  const sym = currencySymbol(currency, locale) || ''

  /* ---- editable state, seeded from the shop ---------------------------- */
  const [name, setName] = useState(ctx.shop.name ?? '')
  const [email, setEmail] = useState(ctx.shop.email ?? '')
  const [phone, setPhone] = useState(ctx.shop.phone ?? '')
  const [address, setAddress] = useState(ctx.shop.address ?? '')
  const [state, setState] = useState(ctx.shop.state ?? '')
  const [taxLabel, setTaxLabel] = useState(ctx.shop.tax_label ?? '')
  const [taxPct, setTaxPct] = useState(String(ctx.shop.tax_pct ?? ''))
  const [kwh, setKwh] = useState(
    ctx.shop.electricity_rate_kwh == null ? '' : String(ctx.shop.electricity_rate_kwh),
  )
  const [design, setDesign] = useState(String(ctx.rateCard.design_hourly || ''))
  const [finish, setFinish] = useState(String(ctx.rateCard.finishing_hourly || ''))
  const [minimum, setMinimum] = useState(String(ctx.rateCard.minimum_order || ''))
  const [deposit, setDeposit] = useState(String(ctx.rateCard.deposit_pct || ''))
  const [markup, setMarkup] = useState(String(ctx.rateCard.material_markup || ''))

  // First machine, only when there is not one yet.
  const [pName, setPName] = useState('')
  const [pTech, setPTech] = useState('fdm')
  const [pRate, setPRate] = useState('')
  const [pWear, setPWear] = useState('')
  const [pWatts, setPWatts] = useState('')
  const [calcPrice, setCalcPrice] = useState('')
  const [calcLife, setCalcLife] = useState('')

  // First material, only when there is not one yet.
  const [mName, setMName] = useState('PLA')
  const [mPerKg, setMPerKg] = useState('')

  const statePower = powerRateFor(state)
  const taxHint = useMemo(() => taxHintFor(state), [state])
  const wear = wearPerHour({ price: calcPrice, lifetimeHours: calcLife })
  const implied = rateImplies(design)

  const section = plan.sections.find((s) => s.id === at)!
  const order = plan.sections.map((s) => s.id)
  const idx = order.indexOf(at)

  async function saveSection(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      if (at === 'identity' || at === 'place' || at === 'power') {
        await saveShopIdentity(ctx.shop.id, {
          name: name.trim(),
          legal_name: ctx.shop.legal_name ?? '',
          address: address.trim(),
          state,
          email: email.trim(),
          phone: phone.trim(),
          license_no: ctx.shop.license_no ?? '',
          electricity_rate_kwh: orNull(kwh),
          currency,
          locale,
          paper: ctx.shop.paper ?? '',
        } as never)
      }
      if (at === 'place') {
        await saveShopQuoteTerms(ctx.shop.id, {
          tax_label: taxLabel.trim(),
          tax_pct: num(taxPct),
          quote_valid_days: Number(ctx.shop.quote_valid_days ?? 30),
          lead_days: Number(ctx.shop.lead_days ?? 10),
          terms_text: ctx.shop.terms_text ?? '',
          revision_policy: ctx.shop.revision_policy ?? '',
          payment_info: (ctx.shop as never as { payment_info?: string }).payment_info ?? '',
        })
      }
      if (at === 'labour' || at === 'terms') {
        await saveRateCard(ctx.shop.id, {
          ...ctx.rateCard,
          design_hourly: num(design),
          finishing_hourly: num(finish),
          minimum_order: num(minimum),
          deposit_pct: num(deposit),
          material_markup: num(markup) || 1,
        } as never)
      }
      if (at === 'machines' && pName.trim()) {
        await savePrinter(ctx.shop.id, {
          id: null,
          name: pName.trim(),
          model: '',
          tech: pTech,
          rate_hourly: num(pRate),
          wear_hourly: num(pWear),
          watts: orNull(pWatts),
        } as never)
      }
      if (at === 'materials' && mName.trim() && num(mPerKg) > 0) {
        await saveMaterial(ctx.shop.id, {
          id: null,
          name: mName.trim(),
          kind: mName.trim(),
          swatch: '#5A6B7C',
          unit: 'g',
          cost_per_unit: num(mPerKg) / 1000,
          sell_override: null,
        } as never)
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setBusy(false)
    }
  }

  async function next() {
    try {
      await saveSection()
    } catch {
      return
    }
    if (idx < order.length - 1) setAt(order[idx + 1])
    else leave()
  }

  const pct = Math.round(plan.completeness * 100)

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40, maxWidth: 1080 }}>
      <div className="section-head">
        <div>
          <h2>Setting up {ctx.shop.name || 'your shop'}</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            {pct}% configured · {plan.remaining.length} section
            {plan.remaining.length === 1 ? '' : 's'} left · everything saves as you go
          </div>
        </div>
        <button type="button" className="btn ghost" onClick={leave}>
          Finish later
        </button>
      </div>

      <div className="stepper">
        {plan.sections.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`step${s.id === at ? ' cur' : s.status === 'done' ? ' done' : ''}`}
            onClick={() => setAt(s.id)}
          >
            <i />
            {s.title}
          </button>
        ))}
      </div>

      {error && (
        <div className="alert">
          <span>{error}</span>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) 320px',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <div className="pane" style={{ margin: 0 }}>
          <h3>
            {section.title}
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--txt-3)', textTransform: 'none', letterSpacing: 0 }}>
              step {idx + 1} of {order.length}
            </span>
          </h3>
          <div style={{ fontSize: 12, color: 'var(--txt-2)', marginBottom: 12 }}>
            {section.decides}
          </div>

          {at === 'identity' && (
            <>
              <div className="fld">
                <label className="lbl" htmlFor="g-name">What is your shop called?</label>
                <input id="g-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                <div className="hint">This is the name at the top of every quote you send.</div>
              </div>
              <div className="grid2" style={{ marginTop: 10 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="g-email">Email</label>
                  <input id="g-email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="g-phone">Phone</label>
                  <input id="g-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                A client needs one way to reply. Either is enough.
              </div>
            </>
          )}

          {at === 'place' && (
            <>
              <div className="fld">
                <label className="lbl" htmlFor="g-addr">Where is the shop?</label>
                <input id="g-addr" autoFocus value={address} onChange={(e) => setAddress(e.target.value)} />
              </div>
              {US_STATES.length > 0 && (
                <div className="fld" style={{ marginTop: 10, maxWidth: 260 }}>
                  <label className="lbl" htmlFor="g-state">State</label>
                  <select id="g-state" value={state} onChange={(e) => setState(e.target.value)}>
                    <option value="">— outside the US —</option>
                    {US_STATES.map(([code, label]) => (
                      <option key={code} value={code}>{label}</option>
                    ))}
                  </select>
                  <div className="hint">Answers what your tax is called and what power costs here.</div>
                </div>
              )}
              <div className="grid2" style={{ marginTop: 10 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="g-taxname">What is your tax called?</label>
                  <input id="g-taxname" value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} placeholder="Sales tax" />
                  {taxHint && (
                    <div className="guide">
                      <div className="guide-g">
                        <div className="guide-h">
                          <span className="guide-tag">{state}</span>
                          <button type="button" className="btn sm" onClick={() => setTaxLabel(taxHint.label)}>
                            Use “{taxHint.label}”
                          </button>
                        </div>
                        <div className="guide-note">{taxHint.note}</div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="g-taxpct">Rate %</label>
                  <input id="g-taxpct" type="number" step="0.001" min="0" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} />
                  <div className="hint">0 if you don't charge it.</div>
                </div>
              </div>
            </>
          )}

          {at === 'power' && (
            <div className="fld" style={{ maxWidth: 320 }}>
              <label className="lbl" htmlFor="g-kwh">What do you pay per kWh?</label>
              <input id="g-kwh" autoFocus type="number" step="0.0001" min="0" value={kwh} onChange={(e) => setKwh(e.target.value)} placeholder="from your utility bill" />
              <div className="hint">
                Look at your last bill if you have it. If not, take the published average for your
                state and replace it later.
              </div>
              <FieldGuide
                groups={[
                  statePower && {
                    tag: 'Published',
                    rows: [
                      { label: `${state}, commercial average`, value: `${sym}${statePower.perKwh.toFixed(4)}/kWh` },
                      { label: 'US average', value: `${sym}${(US_AVERAGE_CENTS / 100).toFixed(4)}/kWh` },
                    ],
                    note:
                      statePower.timesAverage >= 1.5
                        ? `Power here runs about ${statePower.timesAverage.toFixed(1)}× the national average, so guessing at it would be expensive.`
                        : 'An average, not your bill. Replace it when you have one.',
                    cite: `${statePower.sourceShort} ${statePower.asOf}`,
                    action: {
                      label: `Use ${statePower.perKwh.toFixed(4)}`,
                      onClick: () => setKwh(statePower.perKwh.toFixed(4)),
                    },
                  },
                ]}
              />
            </div>
          )}

          {at === 'machines' && (
            ctx.printerRows.filter((p) => !p.archived).length > 0 ? (
              <div className="hint">
                You have {ctx.printerRows.filter((p) => !p.archived).length} machine
                {ctx.printerRows.filter((p) => !p.archived).length === 1 ? '' : 's'} on file.
                {section.missing.length > 0 && (
                  <> Still missing: {section.missing.join(', ')}.{' '}
                    <button type="button" className="addnote" onClick={() => navigate('/settings?tab=machines')}>
                      fix it in Machines
                    </button>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="grid2">
                  <div className="fld">
                    <label className="lbl" htmlFor="g-pname">What do you call it?</label>
                    <input id="g-pname" autoFocus value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Bay 1" />
                  </div>
                  <div className="fld">
                    <label className="lbl" htmlFor="g-ptech">Technology</label>
                    <select id="g-ptech" value={pTech} onChange={(e) => setPTech(e.target.value)}>
                      <option value="fdm">FDM — filament</option>
                      <option value="resin">Resin — MSLA / SLA</option>
                      <option value="composite">Composite — continuous fiber</option>
                      <option value="sls">SLS — powder</option>
                    </select>
                  </div>
                </div>
                <div className="grid3" style={{ marginTop: 10 }}>
                  <div className="fld">
                    <label className="lbl" htmlFor="g-prate">Rate per hour</label>
                    <input id="g-prate" type="number" min="0" value={pRate} onChange={(e) => setPRate(e.target.value)} />
                  </div>
                  <div className="fld">
                    <label className="lbl" htmlFor="g-pwear">Wear per hour</label>
                    <input id="g-pwear" type="number" min="0" value={pWear} onChange={(e) => setPWear(e.target.value)} />
                  </div>
                  <div className="fld">
                    <label className="lbl" htmlFor="g-pwatts">Watts while printing</label>
                    <input id="g-pwatts" type="number" min="0" value={pWatts} onChange={(e) => setPWatts(e.target.value)} placeholder="from the spec sheet" />
                  </div>
                </div>
                <div className="grid2" style={{ marginTop: 10 }}>
                  <div className="fld">
                    <label className="lbl" htmlFor="g-cprice">What the machine cost</label>
                    <input id="g-cprice" type="number" min="0" value={calcPrice} onChange={(e) => setCalcPrice(e.target.value)} />
                  </div>
                  <div className="fld">
                    <label className="lbl" htmlFor="g-clife">Print hours you expect from it</label>
                    <input id="g-clife" type="number" min="0" value={calcLife} onChange={(e) => setCalcLife(e.target.value)} placeholder="5000" />
                  </div>
                </div>
                <FieldGuide
                  groups={[
                    wear && {
                      tag: 'Yours',
                      own: true,
                      rows: [{ label: 'Wear per hour', value: money(wear.perHour) }],
                      note: 'Machine price divided by the hours you expect out of it.',
                      action: {
                        label: 'Use it',
                        onClick: () => setPWear(String(Math.round(wear.perHour * 10000) / 10000)),
                      },
                    },
                    benchmarkGroup(benchmarksFor('wearHourly', currency), fmtBench),
                  ]}
                />
              </>
            )
          )}

          {at === 'materials' && (
            ctx.materials.length > 0 ? (
              <div className="hint">
                You have {ctx.materials.length} material{ctx.materials.length === 1 ? '' : 's'} on
                file.{' '}
                <button type="button" className="addnote" onClick={() => navigate('/settings?tab=materials')}>
                  manage them in Materials
                </button>
              </div>
            ) : (
              <div className="grid2">
                <div className="fld">
                  <label className="lbl" htmlFor="g-mname">What do you print with most?</label>
                  <input id="g-mname" autoFocus value={mName} onChange={(e) => setMName(e.target.value)} />
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="g-mkg">What a kilo costs you</label>
                  <input id="g-mkg" type="number" min="0" value={mPerKg} onChange={(e) => setMPerKg(e.target.value)} />
                  <FieldGuide groups={[benchmarkGroup(benchmarksFor('materialPerKg', currency), fmtBench)]} />
                </div>
              </div>
            )
          )}

          {at === 'labour' && (
            <div className="grid2">
              <div className="fld">
                <label className="lbl" htmlFor="g-design">Design and modeling, per hour</label>
                <input id="g-design" autoFocus type="number" min="0" value={design} onChange={(e) => setDesign(e.target.value)} />
                <FieldGuide
                  groups={[
                    implied && {
                      tag: 'Yours',
                      own: true,
                      rows: [
                        { label: `A day (${implied.dayHours} h)`, value: money(implied.perDay) },
                        { label: `A year (${implied.billableHoursPerWeek} billable h/wk)`, value: money(implied.perYear) },
                      ],
                    },
                    benchmarkGroup(benchmarksFor('designHourly', currency), fmtBench),
                  ]}
                />
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="g-finish">Finishing, per hour</label>
                <input id="g-finish" type="number" min="0" value={finish} onChange={(e) => setFinish(e.target.value)} />
                <div className="hint">Support removal, sanding, wash and cure.</div>
              </div>
            </div>
          )}

          {at === 'terms' && (
            <div className="grid3">
              <div className="fld">
                <label className="lbl" htmlFor="g-min">Shop minimum</label>
                <input id="g-min" autoFocus type="number" min="0" value={minimum} onChange={(e) => setMinimum(e.target.value)} />
                <FieldGuide groups={[benchmarkGroup(benchmarksFor('minimumOrder', currency), fmtBench)]} />
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="g-dep">Deposit %</label>
                <input id="g-dep" type="number" min="0" max="100" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
                <FieldGuide groups={[benchmarkGroup(benchmarksFor('depositPct', currency), fmtBench)]} />
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="g-markup">Material markup ×</label>
                <input id="g-markup" type="number" step="0.1" min="1" value={markup} onChange={(e) => setMarkup(e.target.value)} />
                <FieldGuide groups={[benchmarkGroup(benchmarksFor('markup', currency), fmtBench)]} />
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center' }}>
            {idx > 0 && (
              <button type="button" className="btn" onClick={() => setAt(order[idx - 1])} disabled={busy}>
                Back
              </button>
            )}
            <button type="button" className="btn primary" onClick={next} disabled={busy} style={{ marginLeft: 'auto' }}>
              {busy ? 'Saving…' : idx === order.length - 1 ? 'Done' : 'Save and continue'}
            </button>
          </div>
        </div>

        {/* ------------------------------------------------- what it decides */}
        <div className="pane" style={{ margin: 0 }}>
          <div className="k" style={{ fontSize: 11 }}>Why this one matters</div>
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--txt-2)', marginTop: 6 }}>
            {section.cost ?? 'This one is answered. Nothing downstream is waiting on it.'}
          </div>

          <div style={{ height: 1, background: 'var(--line)', margin: '13px 0' }} />

          <div className="k" style={{ fontSize: 11 }}>Still open</div>
          <div className="guide" style={{ marginTop: 8 }}>
            {plan.remaining.length === 0 ? (
              <div className="guide-g">
                <div className="guide-note">Everything is answered.</div>
              </div>
            ) : (
              plan.remaining.map((s) => (
                <div className="guide-g" key={s.id}>
                  <div className="guide-h">
                    <span className={s.distorts ? 'guide-tag' : 'guide-tag alt'}>
                      {s.distorts ? 'Distorting' : 'Open'}
                    </span>
                    <button type="button" className="addnote" onClick={() => setAt(s.id)}>
                      {s.title}
                    </button>
                  </div>
                  {s.missing.length > 0 && (
                    <div className="guide-note">{s.missing.join(', ')}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
