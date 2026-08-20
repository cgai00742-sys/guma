/**
 * Shop settings → Rates. Recreated from design/Shop Settings.dc.html.
 *
 * The other four tabs (Machines, Materials, Quote terms, Identity) are designed
 * and in the package but out of scope for this build; they are rendered as
 * disabled tab stops so the shape of the screen is honest rather than hidden.
 *
 * Every field on this screen is a column on `rate_cards`. Nothing here is a
 * constant in the code — that is the whole point of the screen.
 */
import { useMemo, useState } from 'react'
import {
  priceQuote,
  money,
  trimPct,
  type QuoteInputs,
  type RateSet,
} from '../lib/pricing'
import { saveRateCard, toRateSet, type ShopContext } from '../lib/data'

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

export default function Settings({ ctx, onSaved }: { ctx: ShopContext; onSaved: () => void }) {
  const card = ctx.rateCard
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
      </div>

      <div className="tabs" style={{ marginBottom: 16 }}>
        <button type="button" className="tab" aria-selected="true">
          Rates
        </button>
        {['Machines', 'Materials', 'Quote terms', 'Identity'].map((t) => (
          <button
            key={t}
            type="button"
            className="tab"
            aria-selected="false"
            disabled
            title="Designed, not in this build."
            style={{ opacity: 0.4, cursor: 'not-allowed' }}
          >
            {t}
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
                Your margin
              </span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right', color: marginInk }}>
                {money(q.margin)}
              </span>
            </div>
            <div className="hint">
              Margin counts your own hours as already paid. If this number is thin, the rates above are the reason.
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
    </div>
  )
}
