/**
 * Shop settings. Rates, Identity and Quote terms are real; Machines is real
 * for editing what's already there; Materials is still designed only, not in
 * this build, and stays a disabled tab stop so the shape of the screen is
 * honest rather than hidden.
 *
 * Every field on the Rates tab is a column on `rate_cards`. Identity and
 * Quote terms are columns on `shops` that have existed since the first
 * migration — this screen just never grew the UI to reach them until now.
 * Nothing here is a constant in the code — that is the whole point.
 */
import { useMemo, useState } from 'react'
import {
  priceQuote,
  makeMoney,
  trimPct,
  type QuoteInputs,
  type RateSet,
} from '../lib/pricing'
import {
  saveRateCard,
  saveShopIdentity,
  saveShopQuoteTerms,
  savePrinter,
  toRateSet,
  type ShopContext,
  type ShopIdentityInput,
  type ShopQuoteTermsInput,
  type PrinterRow,
} from '../lib/data'

/**
 * The sample job from the design: four brackets, six hours modelling, PA-CF,
 * five print hours each, two hours finishing. It re-prices on every keystroke
 * and is what turns an abstract rate into a decision.
 */
const SAMPLE: QuoteInputs = {
  assetOrigin: 'model',
  designBilling: 'hourly',
  designQty: 6,
  revisions: 2,
  quantity: 4,
  unitsPerPart: 185,
  printHrsPerPart: 5,
  finishingHrs: 2,
  rush: false,
  flatEach: 0,
  discountPct: 0,
}

interface Draft {
  design_hourly: number
  finishing_hourly: number
  rush_pct: number
  minimum_order: number
  deposit_pct: number
  deposit_when: 'design' | 'print' | 'none'
  deposit_waive_below: number
  material_markup: number
  revisions_incl: number
  revision_hourly: number | null
}

const DEPOSIT_HINTS: Record<Draft['deposit_when'], string> = {
  design:
    'You model before anything prints — that is your time at risk with nothing to repossess. This is the right setting for a shop that designs.',
  print:
    'Safer for the client, riskier for you: a job cancelled after modelling leaves you unpaid for the largest line on the quote.',
  none: "Only if every client is someone you'd lend a truck to.",
}

type Tab = 'rates' | 'identity' | 'terms' | 'machines'

export default function Settings({ ctx, onSaved }: { ctx: ShopContext; onSaved: () => void }) {
  const [tab, setTab] = useState<Tab>('rates')
  const card = ctx.rateCard
  // Currency comes from the shop record, not from the code.
  const { money } = useMemo(
    () => makeMoney(ctx.shop.currency || 'USD', ctx.shop.locale || 'en-US'),
    [ctx.shop.currency, ctx.shop.locale],
  )
  const [draft, setDraft] = useState<Draft>({
    design_hourly: Number(card.design_hourly),
    finishing_hourly: Number(card.finishing_hourly),
    rush_pct: Number(card.rush_pct),
    minimum_order: Number(card.minimum_order),
    deposit_pct: Number(card.deposit_pct),
    deposit_when: card.deposit_when,
    deposit_waive_below: Number(card.deposit_waive_below),
    material_markup: Number(card.material_markup),
    revisions_incl: card.revisions_incl,
    revision_hourly: card.revision_hourly == null ? null : Number(card.revision_hourly),
  })
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const num = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    setDraft((d) => ({ ...d, [k]: isNaN(v) ? 0 : v }))
    setDirty(true)
  }

  // The live rate set the sample panel prices against — the draft, not the
  // saved row, so the number moves as you type.
  const liveRates: RateSet = useMemo(
    () => ({
      ...toRateSet({ ...card, ...draft }, ctx.shop),
    }),
    [card, draft, ctx.shop],
  )

  // The design's sample is PA-CF on the shop's machine. Fall back to whatever
  // the shop actually has rather than inventing a material.
  const material = useMemo(
    () => ctx.materials.find((m) => m.name.includes('PA-CF')) ?? ctx.materials[0] ?? null,
    [ctx.materials],
  )
  const printer = ctx.printers[0] ?? null

  const q = useMemo(
    () => priceQuote(SAMPLE, liveRates, material, printer),
    [liveRates, material, printer],
  )

  const marginInk =
    q.margin < 0 ? 'var(--red)' : q.marginPctOfTotal < 0.15 ? 'var(--warn)' : 'var(--ok)'

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await saveRateCard(ctx.shop.id, draft)
      setDirty(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const owner = ctx.profile.role === 'owner'

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 48 }}>
      <div className="section-head">
        <div>
          <h2>Shop settings</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            {ctx.shop.name} · {ctx.shop.address} · every number here is yours to change
          </div>
        </div>
        {tab === 'rates' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: dirty ? 'var(--warn)' : 'var(--txt-3)' }}>
              {dirty ? 'Unsaved changes' : 'All saved'}
            </span>
            <button
              type="button"
              className="btn primary"
              onClick={save}
              disabled={!dirty || saving || !owner}
              title={owner ? undefined : 'Only the shop owner can change rates.'}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </div>

      <div className="tabs" style={{ marginBottom: 16 }}>
        <button type="button" className="tab" aria-selected={tab === 'rates'} onClick={() => setTab('rates')}>
          Rates
        </button>
        <button type="button" className="tab" aria-selected={tab === 'machines'} onClick={() => setTab('machines')}>
          Machines
        </button>
        <button
          type="button"
          className="tab"
          aria-selected="false"
          disabled
          title="Designed, not in this build."
          style={{ opacity: 0.4, cursor: 'not-allowed' }}
        >
          Materials
        </button>
        <button type="button" className="tab" aria-selected={tab === 'terms'} onClick={() => setTab('terms')}>
          Quote terms
        </button>
        <button type="button" className="tab" aria-selected={tab === 'identity'} onClick={() => setTab('identity')}>
          Identity
        </button>
      </div>

      {tab === 'identity' && <IdentityPane ctx={ctx} onSaved={onSaved} />}
      {tab === 'terms' && <QuoteTermsPane ctx={ctx} onSaved={onSaved} />}
      {tab === 'machines' && <MachinesPane ctx={ctx} onSaved={onSaved} />}

      {tab === 'rates' && error && (
        <div className="alert">
          <span>{error}</span>
        </div>
      )}

      {tab === 'rates' && (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) 340px',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="pane" style={{ margin: 0 }}>
            <h3>
              Labour
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--txt-3)',
                  textTransform: 'none',
                  letterSpacing: 0,
                }}
              >
                your time
              </span>
            </h3>
            <div className="grid2">
              <div className="fld">
                <label className="lbl" htmlFor="s-design">
                  Design and modelling, per hour
                </label>
                <input id="s-design" type="number" min="0" value={draft.design_hourly} onChange={num('design_hourly')} />
                <div className="hint">
                  The biggest line on most of your quotes. Set it where an eight-hour modelling day pays what a day of
                  your time is worth.
                </div>
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="s-post">
                  Finishing labour, per hour
                </label>
                <input
                  id="s-post"
                  type="number"
                  min="0"
                  value={draft.finishing_hourly}
                  onChange={num('finishing_hourly')}
                />
                <div className="hint">
                  Support removal, sanding, wash and cure, assembly. Lower than design because it is hands, not
                  judgment.
                </div>
              </div>
            </div>
          </div>

          <div className="pane" style={{ margin: 0 }}>
            <h3>Floor and surcharges</h3>
            <div className="grid3">
              <div className="fld">
                <label className="lbl" htmlFor="s-min">
                  Shop minimum
                </label>
                <input id="s-min" type="number" min="0" value={draft.minimum_order} onChange={num('minimum_order')} />
                <div className="hint">No job leaves for less. Covers the setup you do regardless of size.</div>
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="s-rush">
                  Rush surcharge %
                </label>
                <input id="s-rush" type="number" min="0" max="200" value={draft.rush_pct} onChange={num('rush_pct')} />
                <div className="hint">
                  Charged for jumping the queue and taking a machine off what it was doing.
                </div>
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="s-tax">
                  {ctx.shop.tax_label} %
                </label>
                {/* Read-only here: the tax rate lives on `shops`, edited on the
                    Quote terms tab, which is not in this build. */}
                <input id="s-tax" type="number" value={ctx.shop.tax_pct} readOnly disabled />
                <div className="hint">
                  Applied last — after any discount. Lives on the shop record, not the rate card, and moves on the Quote
                  terms tab.
                </div>
              </div>
            </div>
          </div>

          <div className="pane" style={{ margin: 0 }}>
            <h3>
              Deposit
              <span className="badge" style={{ background: 'var(--warn)', color: 'var(--ink)' }}>
                MONEY AT RISK
              </span>
            </h3>
            <div className="grid2">
              <div className="fld">
                <label className="lbl" htmlFor="s-dep">
                  Deposit %
                </label>
                <input id="s-dep" type="number" min="0" max="100" value={draft.deposit_pct} onChange={num('deposit_pct')} />
                <div className="hint">Of the quote total, collected before you start.</div>
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="s-depwhen">
                  Collected
                </label>
                <select
                  id="s-depwhen"
                  value={draft.deposit_when}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, deposit_when: e.target.value as Draft['deposit_when'] }))
                    setDirty(true)
                  }}
                >
                  <option value="design">Before design starts</option>
                  <option value="print">After approval, before printing</option>
                  <option value="none">No deposit</option>
                </select>
                <div className="hint">{DEPOSIT_HINTS[draft.deposit_when]}</div>
              </div>
            </div>
            <div className="fld" style={{ marginTop: 10 }}>
              <label className="lbl" htmlFor="s-depthresh">
                Waive below
              </label>
              <input
                id="s-depthresh"
                type="number"
                min="0"
                value={draft.deposit_waive_below}
                onChange={num('deposit_waive_below')}
              />
              <div className="hint">
                Small jobs skip the deposit — chasing $30 costs more than it collects. Set to 0 to always take one.
              </div>
            </div>
          </div>

          <div className="pane" style={{ margin: 0 }}>
            <h3>Materials</h3>
            <div className="grid2">
              <div className="fld">
                <label className="lbl" htmlFor="s-markup">
                  Markup multiplier on cost
                </label>
                <input
                  id="s-markup"
                  type="number"
                  step="0.1"
                  min="0"
                  value={draft.material_markup}
                  onChange={num('material_markup')}
                />
                <div className="hint">
                  Every material's sell price is cost × this, unless that material pins its own. The sample below
                  re-prices as you move it.
                </div>
              </div>
              <div className="fld">
                <label className="lbl">What that does to your stock</label>
                <div
                  className="kv"
                  style={{ gridTemplateColumns: '1fr auto', gap: '4px 12px', marginTop: 2 }}
                >
                  {ctx.materials.map((m) => (
                    <span key={m.id} style={{ display: 'contents' }}>
                      <span className="k" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <i
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: 2,
                            background: m.swatch,
                            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.18)',
                            flex: 'none',
                          }}
                        />
                        {m.name}
                      </span>
                      <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                        {money(m.costPerUnit * 1000)} →{' '}
                        {money(
                          (m.sellOverride ?? m.costPerUnit * draft.material_markup) * 1000,
                        )}
                        /kg
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="pane" style={{ margin: 0 }}>
            <h3>Revisions</h3>
            <div className="grid2">
              <div className="fld">
                <label className="lbl" htmlFor="s-rev">
                  Rounds included by default
                </label>
                <input id="s-rev" type="number" min="0" value={draft.revisions_incl} onChange={num('revisions_incl')} />
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="s-revrate">
                  Beyond that, per hour
                </label>
                <input
                  id="s-revrate"
                  type="number"
                  min="0"
                  value={draft.revision_hourly ?? ''}
                  onChange={num('revision_hourly')}
                />
                <div className="hint">
                  Usually the same as your design rate. Lower it only if you want to encourage fiddling.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sticky live sample. Calm register — the one lit element is the card
            border, and the total in --biolum because it is genuinely live. */}
        <div style={{ position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--lit-edge)',
              borderRadius: 8,
              padding: '14px 16px',
            }}
          >
            <div
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '.06em',
                color: 'var(--txt-3)',
              }}
            >
              What this does to a typical job
            </div>
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--txt-2)', marginTop: 6 }}>
              Four brackets. Six hours modelling, {material ? material.name : 'material'}, five print hours each, two
              hours finishing.
            </div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 32,
                lineHeight: '36px',
                fontWeight: 650,
                color: 'var(--biolum)',
                marginTop: 12,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {money(q.total)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2 }}>
              {money(q.perUnit)} per bracket · {q.deposit > 0 ? `${money(q.deposit)} due up front` : 'no deposit'}
            </div>
            <div style={{ height: 1, background: 'var(--line)', margin: '13px 0' }} />
            <div className="kv" style={{ gridTemplateColumns: '1fr auto', gap: '5px 12px' }}>
              <span className="k">Design</span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                {money(q.designAmt)}
              </span>
              <span className="k">Material</span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                {money(q.materialSell)}
              </span>
              <span className="k">Machine + wear</span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                {money(q.machineAmt + q.wearAmt)}
              </span>
              <span className="k">Finishing</span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                {money(q.finishingAmt)}
              </span>
              <span className="k">
                {ctx.shop.tax_label} · {trimPct(Number(ctx.shop.tax_pct))}%
              </span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                {money(q.tax)}
              </span>
              <span className="k" style={{ color: 'var(--txt-2)' }}>
                Your margin {q.costsIncomplete ? '(estimate)' : ''}
              </span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right', color: marginInk }}>
                {money(q.margin)}
              </span>
            </div>
            <div className="hint">
              {q.costsIncomplete
                ? 'This treats machine time as break-even because either the printer\'s wattage or your electricity rate isn\'t set yet (Machines and Identity tabs) — the real number could be higher.'
                : "Margin counts your own hours as already paid. If this number is thin, the rates above are the reason."}
            </div>
          </div>

          <div className="notice" style={{ margin: 0 }}>
            <span>
              <b>Rates are versioned.</b> A quote keeps the numbers it was priced with. Saving here writes a new rate
              card and affects new quotes only — nothing a client already holds moves.
            </span>
          </div>
        </div>
      </div>
      )}
    </div>
  )
}

/** Optional identity: who the shop is, where it is, and its own electricity
 *  rate. None of it blocks anything — see Setup.tsx for why — it just makes
 *  the margin estimate on the Rates tab an actual number instead of a guess. */
function IdentityPane({ ctx, onSaved }: { ctx: ShopContext; onSaved: () => void }) {
  const shop = ctx.shop
  const [draft, setDraft] = useState<ShopIdentityInput>({
    name: shop.name ?? '',
    legal_name: shop.legal_name ?? '',
    address: shop.address ?? '',
    email: shop.email ?? '',
    phone: shop.phone ?? '',
    license_no: shop.license_no ?? '',
    electricity_rate_kwh: shop.electricity_rate_kwh,
  })
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const owner = ctx.profile.role === 'owner'

  const str = (k: keyof Omit<ShopIdentityInput, 'electricity_rate_kwh'>) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setDraft((d) => ({ ...d, [k]: e.target.value }))
      setDirty(true)
    }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await saveShopIdentity(shop.id, draft)
      setDirty(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const missing = [
    !draft.name.trim() && 'shop name',
    !draft.address.trim() && 'address',
    draft.electricity_rate_kwh == null && 'electricity rate',
  ].filter(Boolean) as string[]

  return (
    <div style={{ maxWidth: 640 }}>
      {error && (
        <div className="alert" style={{ marginBottom: 12 }}>
          <span>{error}</span>
        </div>
      )}

      {missing.length > 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          <span>
            <b>Not required.</b> {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} blank — Guma still works,
            it just can't give you an exact cost-of-goods number on machine time until they're filled in. Fill in
            what you have; skip the rest.
          </span>
        </div>
      )}

      <div className="pane" style={{ margin: 0 }}>
        <h3>Who you are</h3>
        <div className="grid2">
          <div className="fld">
            <label className="lbl" htmlFor="id-name">Shop name</label>
            <input id="id-name" value={draft.name} onChange={str('name')} />
            <div className="hint">What clients call you. Appears on every quote.</div>
          </div>
          <div className="fld">
            <label className="lbl" htmlFor="id-legal">Legal name</label>
            <input id="id-legal" value={draft.legal_name} onChange={str('legal_name')} placeholder="optional" />
          </div>
        </div>
        <div className="fld" style={{ marginTop: 10 }}>
          <label className="lbl" htmlFor="id-addr">Address</label>
          <input id="id-addr" value={draft.address} onChange={str('address')} placeholder="optional" />
        </div>
        <div className="grid3" style={{ marginTop: 10 }}>
          <div className="fld">
            <label className="lbl" htmlFor="id-email">Email on quotes</label>
            <input id="id-email" type="email" value={draft.email} onChange={str('email')} placeholder="optional" />
          </div>
          <div className="fld">
            <label className="lbl" htmlFor="id-phone">Phone</label>
            <input id="id-phone" value={draft.phone} onChange={str('phone')} placeholder="optional" />
          </div>
          <div className="fld">
            <label className="lbl" htmlFor="id-lic">Tax / business licence no.</label>
            <input id="id-lic" value={draft.license_no} onChange={str('license_no')} placeholder="optional" />
          </div>
        </div>
      </div>

      <div className="pane" style={{ margin: '12px 0 0' }}>
        <h3>What power costs you</h3>
        <div className="fld">
          <label className="lbl" htmlFor="id-kwh">Your electricity rate, $/kWh</label>
          <input
            id="id-kwh"
            type="number"
            step="0.0001"
            min="0"
            value={draft.electricity_rate_kwh ?? ''}
            onChange={(e) => {
              const v = e.target.value
              setDraft((d) => ({ ...d, electricity_rate_kwh: v.trim() === '' ? null : Number(v) }))
              setDirty(true)
            }}
            placeholder="from your utility bill"
          />
          <div className="hint">
            Never looked up or assumed — rates vary by utility, not just region, and this feeds a real dollar figure
            on the Rates tab. Paired with each printer's wattage (Machines tab) to price actual machine-time cost
            instead of treating it as break-even.
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          className="btn primary"
          onClick={save}
          disabled={!dirty || saving || !owner}
          title={owner ? undefined : 'Only the shop owner can change this.'}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

/** Tax, validity windows, and the fine print printed on every quote. */
function QuoteTermsPane({ ctx, onSaved }: { ctx: ShopContext; onSaved: () => void }) {
  const shop = ctx.shop
  const [draft, setDraft] = useState<ShopQuoteTermsInput>({
    tax_label: shop.tax_label ?? '',
    tax_pct: Number(shop.tax_pct) || 0,
    quote_valid_days: shop.quote_valid_days ?? 30,
    lead_days: shop.lead_days ?? 10,
    terms_text: shop.terms_text ?? '',
    revision_policy: shop.revision_policy ?? '',
    payment_info: shop.payment_info ?? '',
  })
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const owner = ctx.profile.role === 'owner'

  function set<K extends keyof ShopQuoteTermsInput>(k: K, v: ShopQuoteTermsInput[K]) {
    setDraft((d) => ({ ...d, [k]: v }))
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await saveShopQuoteTerms(shop.id, draft)
      setDirty(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      {error && (
        <div className="alert" style={{ marginBottom: 12 }}>
          <span>{error}</span>
        </div>
      )}

      <div className="pane" style={{ margin: 0 }}>
        <h3>Tax</h3>
        <div className="grid2">
          <div className="fld">
            <label className="lbl" htmlFor="tt-label">Tax name</label>
            <input
              id="tt-label"
              value={draft.tax_label}
              onChange={(e) => set('tax_label', e.target.value)}
              placeholder="VAT · GST · Sales tax"
            />
            <div className="hint">Printed on the quote exactly as typed.</div>
          </div>
          <div className="fld">
            <label className="lbl" htmlFor="tt-pct">Tax %</label>
            <input
              id="tt-pct"
              type="number"
              step="0.001"
              min="0"
              value={draft.tax_pct}
              onChange={(e) => set('tax_pct', e.target.value === '' ? 0 : Number(e.target.value))}
            />
            <div className="hint">Three decimals allowed — applied last, after any discount.</div>
          </div>
        </div>
      </div>

      <div className="pane" style={{ margin: '12px 0 0' }}>
        <h3>Windows</h3>
        <div className="grid2">
          <div className="fld">
            <label className="lbl" htmlFor="tt-valid">Quote valid for, days</label>
            <input
              id="tt-valid"
              type="number"
              min="1"
              value={draft.quote_valid_days}
              onChange={(e) => set('quote_valid_days', Number(e.target.value) || 1)}
            />
          </div>
          <div className="fld">
            <label className="lbl" htmlFor="tt-lead">Typical lead time, days</label>
            <input
              id="tt-lead"
              type="number"
              min="0"
              value={draft.lead_days}
              onChange={(e) => set('lead_days', Number(e.target.value) || 0)}
            />
          </div>
        </div>
      </div>

      <div className="pane" style={{ margin: '12px 0 0' }}>
        <h3>Fine print</h3>
        <div className="fld">
          <label className="lbl" htmlFor="tt-terms">Terms</label>
          <textarea id="tt-terms" rows={3} value={draft.terms_text} onChange={(e) => set('terms_text', e.target.value)} placeholder="optional" />
        </div>
        <div className="fld" style={{ marginTop: 10 }}>
          <label className="lbl" htmlFor="tt-rev">Revision policy</label>
          <textarea id="tt-rev" rows={2} value={draft.revision_policy} onChange={(e) => set('revision_policy', e.target.value)} placeholder="optional" />
        </div>
        <div className="fld" style={{ marginTop: 10 }}>
          <label className="lbl" htmlFor="tt-pay">Payment info</label>
          <textarea id="tt-pay" rows={2} value={draft.payment_info} onChange={(e) => set('payment_info', e.target.value)} placeholder="optional" />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          className="btn primary"
          onClick={save}
          disabled={!dirty || saving || !owner}
          title={owner ? undefined : 'Only the shop owner can change this.'}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

/** Editing what setup created, plus adding another machine. Wattage is the
 *  field that matters most here — see IdentityPane for the rate it pairs with. */
function MachinesPane({ ctx, onSaved }: { ctx: ShopContext; onSaved: () => void }) {
  const [rows, setRows] = useState<PrinterRow[]>(ctx.printerRows)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draftNew, setDraftNew] = useState<Omit<PrinterRow, 'id'>>({
    name: '', model: '', tech: 'fdm', rate_hourly: 0, wear_hourly: 0, watts: null,
  })
  const owner = ctx.profile.role === 'owner'

  function patch(id: string, field: keyof PrinterRow, value: string) {
    setRows((rs) =>
      rs.map((r) =>
        r.id === id
          ? {
              ...r,
              [field]:
                field === 'name' || field === 'model' || field === 'tech'
                  ? value
                  : field === 'watts'
                    ? (value.trim() === '' ? null : Number(value))
                    : Number(value) || 0,
            }
          : r,
      ),
    )
  }

  async function saveRow(row: PrinterRow) {
    setSavingId(row.id)
    setError(null)
    try {
      await savePrinter(ctx.shop.id, row)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingId(null)
    }
  }

  async function addPrinter() {
    if (!draftNew.name.trim()) return
    setSavingId('new')
    setError(null)
    try {
      await savePrinter(ctx.shop.id, draftNew)
      setDraftNew({ name: '', model: '', tech: 'fdm', rate_hourly: 0, wear_hourly: 0, watts: null })
      setAdding(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div>
      {error && (
        <div className="alert" style={{ marginBottom: 12 }}>
          <span>{error}</span>
        </div>
      )}

      {rows.map((r) => (
        <div key={r.id} className="pane" style={{ margin: '0 0 10px' }}>
          <div className="grid3">
            <div className="fld">
              <label className="lbl" htmlFor={`m-name-${r.id}`}>Name</label>
              <input id={`m-name-${r.id}`} value={r.name} onChange={(e) => patch(r.id, 'name', e.target.value)} />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor={`m-model-${r.id}`}>Model</label>
              <input id={`m-model-${r.id}`} value={r.model} onChange={(e) => patch(r.id, 'model', e.target.value)} />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor={`m-tech-${r.id}`}>Technology</label>
              <select id={`m-tech-${r.id}`} value={r.tech} onChange={(e) => patch(r.id, 'tech', e.target.value)}>
                <option value="fdm">FDM — filament</option>
                <option value="resin">Resin — MSLA / SLA</option>
                <option value="composite">Composite — continuous fibre</option>
                <option value="sls">SLS — powder</option>
              </select>
            </div>
          </div>
          <div className="grid3" style={{ marginTop: 10 }}>
            <div className="fld">
              <label className="lbl" htmlFor={`m-rate-${r.id}`}>Rate per hour</label>
              <input id={`m-rate-${r.id}`} type="number" min="0" value={r.rate_hourly} onChange={(e) => patch(r.id, 'rate_hourly', e.target.value)} />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor={`m-wear-${r.id}`}>Wear per hour</label>
              <input id={`m-wear-${r.id}`} type="number" min="0" value={r.wear_hourly} onChange={(e) => patch(r.id, 'wear_hourly', e.target.value)} />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor={`m-watts-${r.id}`}>Power draw, watts</label>
              <input
                id={`m-watts-${r.id}`}
                type="number"
                min="0"
                value={r.watts ?? ''}
                onChange={(e) => patch(r.id, 'watts', e.target.value)}
                placeholder="optional"
              />
              <div className="hint">With your electricity rate (Identity tab), prices real machine-time cost.</div>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn primary sm"
              onClick={() => saveRow(r)}
              disabled={savingId === r.id || !owner}
            >
              {savingId === r.id ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ))}

      {adding ? (
        <div className="pane" style={{ margin: 0 }}>
          <h3>New machine</h3>
          <div className="grid3">
            <div className="fld">
              <label className="lbl" htmlFor="mn-name">Name</label>
              <input id="mn-name" autoFocus value={draftNew.name} onChange={(e) => setDraftNew((d) => ({ ...d, name: e.target.value }))} placeholder="Bay 2" />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="mn-model">Model</label>
              <input id="mn-model" value={draftNew.model} onChange={(e) => setDraftNew((d) => ({ ...d, model: e.target.value }))} />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="mn-tech">Technology</label>
              <select id="mn-tech" value={draftNew.tech} onChange={(e) => setDraftNew((d) => ({ ...d, tech: e.target.value as PrinterRow['tech'] }))}>
                <option value="fdm">FDM — filament</option>
                <option value="resin">Resin — MSLA / SLA</option>
                <option value="composite">Composite — continuous fibre</option>
                <option value="sls">SLS — powder</option>
              </select>
            </div>
          </div>
          <div className="grid3" style={{ marginTop: 10 }}>
            <div className="fld">
              <label className="lbl" htmlFor="mn-rate">Rate per hour</label>
              <input id="mn-rate" type="number" min="0" value={draftNew.rate_hourly} onChange={(e) => setDraftNew((d) => ({ ...d, rate_hourly: Number(e.target.value) || 0 }))} />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="mn-wear">Wear per hour</label>
              <input id="mn-wear" type="number" min="0" value={draftNew.wear_hourly} onChange={(e) => setDraftNew((d) => ({ ...d, wear_hourly: Number(e.target.value) || 0 }))} />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="mn-watts">Power draw, watts</label>
              <input
                id="mn-watts"
                type="number"
                min="0"
                value={draftNew.watts ?? ''}
                onChange={(e) => setDraftNew((d) => ({ ...d, watts: e.target.value.trim() === '' ? null : Number(e.target.value) }))}
                placeholder="optional"
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" className="btn primary" onClick={addPrinter} disabled={!draftNew.name.trim() || savingId === 'new' || !owner}>
              {savingId === 'new' ? 'Adding…' : 'Add machine'}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setAdding(true)} disabled={!owner}>
          + Add a machine
        </button>
      )}
    </div>
  )
}
