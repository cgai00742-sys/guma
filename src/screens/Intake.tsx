/**
 * Job intake & quote. Recreated from design/Job Intake & Quote.dc.html.
 *
 * Layout is the design's: .wrap, section head, seven-step stepper, then a
 * minmax(0,1fr) 420px grid with four stacked panes on the left and a sticky
 * column on the right. Calm register throughout — the ONLY lit element on the
 * screen is the quote card's --lit-edge border, and the only --biolum is the
 * total, because a live-updating price is genuinely live.
 *
 * No arithmetic lives in this file. Every figure comes from priceQuote().
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  buildRatesSnapshot,
  makeMoney,
  priceQuote,
  trimPct,
  type AssetOrigin,
  type DesignBilling,
  type QuoteInputs,
} from '../lib/pricing'
import { nextJobRef, saveQuote, toRateSet, type ShopContext } from '../lib/data'

const PHASES = [
  'Intake & quote',
  'Design',
  'Client approval',
  'Scheduled',
  'In build',
  'Review',
  'Delivered',
]

const ASSET_NOTES: Record<AssetOrigin, string> = {
  model:
    'You build the model from scratch — measurements, CAD, test print, fit check. This is most jobs, and it is the biggest line on the quote.',
  fix: "Client sent a file that won't print as-is: wall thickness, non-manifold geometry, orientation, or a scale that has to be resolved before slicing.",
  ready: 'A print-ready file you only have to slice. No design line on the quote.',
}

const SOURCES = ['Word of mouth', 'Repeat client', 'Referral', 'Walk-in', 'Website enquiry']

export default function Intake({ ctx }: { ctx: ShopContext }) {
  const navigate = useNavigate()
  const rates = useMemo(() => toRateSet(ctx.rateCard, ctx.shop), [ctx.rateCard, ctx.shop])
  const { money, money0 } = useMemo(
    () => makeMoney(rates.currency, rates.locale),
    [rates.currency, rates.locale],
  )

  const [ref, setRef] = useState<string>('…')
  useEffect(() => {
    nextJobRef(ctx.shop.id).then(setRef).catch(() => setRef('GUMA-DRAFT'))
  }, [ctx.shop.id])

  // Who it's for
  const [client, setClient] = useState('')
  const [contact, setContact] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [source, setSource] = useState(SOURCES[0])
  const [neededBy, setNeededBy] = useState('')
  const [brief, setBrief] = useState('')
  const [title, setTitle] = useState('')

  // The quote inputs proper
  const [input, setInput] = useState<QuoteInputs>({
    assetOrigin: 'model',
    designBilling: 'hourly',
    designQty: 6,
    revisions: ctx.rateCard.revisions_incl,
    quantity: 1,
    unitsPerPart: 0,
    printHrsPerPart: 0,
    finishingHrs: 0,
    rush: false,
    flatEach: 0,
    discountPct: 0,
  })
  const [materialId, setMaterialId] = useState(ctx.materials[0]?.id ?? '')
  const [printerId, setPrinterId] = useState(ctx.printers[0]?.id ?? '')

  const [saving, setSaving] = useState<'idle' | 'draft' | 'send'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const material = ctx.materials.find((m) => m.id === materialId) ?? null
  const printer = ctx.printers.find((p) => p.id === printerId) ?? null

  const set = <K extends keyof QuoteInputs>(k: K) => (v: QuoteInputs[K]) =>
    setInput((s) => ({ ...s, [k]: v }))
  const num = <K extends keyof QuoteInputs>(k: K) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    setInput((s) => ({ ...s, [k]: (isNaN(v) ? 0 : v) as QuoteInputs[K] }))
  }

  const q = useMemo(
    () => priceQuote(input, rates, material, printer),
    [input, rates, material, printer],
  )

  const unitWord = material?.unit === 'ml' ? 'Millilitres' : 'Grams'
  const canSave = client.trim().length > 0 && title.trim().length > 0

  async function persist(mode: 'draft' | 'send') {
    if (!canSave) {
      setError('A client name and a job title are needed before this can be saved.')
      return
    }
    setSaving(mode)
    setError(null)
    try {
      const validUntil = new Date()
      validUntil.setDate(validUntil.getDate() + ctx.shop.quote_valid_days)

      const saved = await saveQuote({
        shopId: ctx.shop.id,
        ref,
        client: { name: client.trim(), contact, email, phone, source },
        job: {
          title: title.trim(),
          brief,
          neededBy: neededBy || null,
          assetOrigin: input.assetOrigin,
        },
        quote: {
          design_billing: input.assetOrigin === 'ready' ? 'none' : input.designBilling,
          design_qty: input.designQty,
          revisions_incl: input.revisions,
          quantity: input.quantity,
          material_id: materialId || null,
          printer_id: printerId || null,
          units_per_part: input.unitsPerPart,
          print_hrs_part: input.printHrsPerPart,
          finishing_hrs: input.finishingHrs,
          rush: input.rush,
          flat_each: input.flatEach,
          discount_pct: input.discountPct,
        },
        send:
          mode === 'send'
            ? {
                // Frozen at send time. A later rate change must never alter a
                // quote the client already holds.
                rates_snapshot: buildRatesSnapshot(rates, material, printer),
                total: Number(q.total.toFixed(2)),
                deposit_due: q.deposit,
                valid_until: validUntil.toISOString().slice(0, 10),
              }
            : undefined,
      })

      if (mode === 'send') {
        navigate(`/quote/${saved.quoteId}/print`)
      } else {
        setSavedNote(`Saved as draft · ${saved.ref}`)
        setRef(await nextJobRef(ctx.shop.id))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving('idle')
    }
  }

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <div className="section-head">
        <div>
          <h2>New job · intake</h2>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--txt-3)',
              marginTop: 3,
            }}
          >
            <span>
              {ref} · opened today · {ctx.profile.full_name}
            </span>
            {/* Same rule persist() already enforces (client + job title) —
                just surfaced here so it's visible while filling the form
                out, not only as an error after Save is clicked. */}
            <span
              className="chip"
              style={
                canSave
                  ? { borderColor: 'color-mix(in srgb, var(--ok) 45%, transparent)', color: 'var(--ok)' }
                  : { borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)', color: 'var(--warn)' }
              }
            >
              {canSave ? 'Ready to save' : 'Pending — needs a client and job title'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn"
            onClick={() => persist('draft')}
            disabled={saving !== 'idle' || !canSave}
            title={canSave ? undefined : 'Add a client name and a job title first.'}
          >
            {saving === 'draft' ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => persist('send')}
            disabled={saving !== 'idle' || !canSave}
            title={
              canSave
                ? "Freezes today's rates onto this quote and opens the printable version. Guma doesn't email anything — it's yours to save as a PDF or hand to the client however you like."
                : 'Add a client name and a job title first.'
            }
          >
            {saving === 'send' ? 'Preparing…' : 'Save quote as PDF'}
          </button>
        </div>
      </div>

      <div className="stepper">
        {PHASES.map((p, i) => (
          <span key={p} className={i === 0 ? 'step cur' : 'step'}>
            <i />
            {p}
          </span>
        ))}
      </div>

      {error && (
        <div className="alert">
          <span>{error}</span>
        </div>
      )}
      {savedNote && (
        <div className="okbar">
          <span>{savedNote}</span>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) 420px',
          gap: 16,
          alignItems: 'start',
        }}
      >
        {/* ---------------------------------------------------- left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="pane" style={{ margin: 0 }}>
            <h3>Who it's for</h3>
            <div className="grid2">
              <div className="fld">
                <label className="lbl" htmlFor="q-client">
                  Client
                </label>
                <input id="q-client" value={client} onChange={(e) => setClient(e.target.value)} />
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="q-contact">
                  Contact
                </label>
                <input
                  id="q-contact"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="Ray Q. — ops lead"
                />
              </div>
            </div>
            <div className="grid2" style={{ marginTop: 10 }}>
              <div className="fld">
                <label className="lbl" htmlFor="q-email">
                  Email
                </label>
                <input id="q-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="q-phone">
                  Phone
                </label>
                <input id="q-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
            <div className="grid2" style={{ marginTop: 10 }}>
              <div className="fld">
                <label className="lbl" htmlFor="q-how">
                  How they found us
                </label>
                <select id="q-how" value={source} onChange={(e) => setSource(e.target.value)}>
                  {SOURCES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="q-need">
                  Needed by
                </label>
                <input id="q-need" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
              </div>
            </div>
            <div className="fld" style={{ marginTop: 10 }}>
              <label className="lbl" htmlFor="q-title">
                Job title
              </label>
              <input
                id="q-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Four sensor mast brackets"
              />
            </div>
            <div className="fld" style={{ marginTop: 10 }}>
              <label className="lbl" htmlFor="q-brief">
                What they asked for
              </label>
              <textarea id="q-brief" rows={2} value={brief} onChange={(e) => setBrief(e.target.value)} />
            </div>
          </div>

          <div className="pane" style={{ margin: 0 }}>
            <h3>
              The asset
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--txt-3)',
                  textTransform: 'none',
                  letterSpacing: 0,
                }}
              >
                drives the design line
              </span>
            </h3>
            <div className="seg" role="group" aria-label="Asset origin" style={{ marginBottom: 12 }}>
              {(
                [
                  ['model', 'I model it'],
                  ['fix', 'Client file needs work'],
                  ['ready', 'Print-ready file'],
                ] as [AssetOrigin, string][]
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={input.assetOrigin === v}
                  onClick={() =>
                    setInput((s) => ({
                      ...s,
                      assetOrigin: v,
                      designQty:
                        v === 'fix' ? (s.designBilling === 'flat' ? 250 : 2) : s.designQty,
                    }))
                  }
                >
                  {label}
                </button>
              ))}
            </div>

            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                border: '1px solid var(--line)',
                background: 'var(--panel-2)',
                borderRadius: 'var(--radius)',
                padding: '10px 12px',
                marginBottom: 12,
              }}
            >
              <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--txt-2)' }}>
                {ASSET_NOTES[input.assetOrigin]}
              </span>
            </div>

            {q.needsDesign && (
              <div>
                <div className="seg" role="group" aria-label="How design is billed" style={{ marginBottom: 12 }}>
                  {(
                    [
                      ['hourly', 'Bill hourly'],
                      ['flat', 'Flat design fee'],
                    ] as [DesignBilling, string][]
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={input.designBilling === v}
                      onClick={() =>
                        setInput((s) => ({
                          ...s,
                          designBilling: v,
                          designQty: v === 'flat' ? 600 : 6,
                        }))
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="grid2">
                  <div className="fld">
                    <label className="lbl" htmlFor="q-dh">
                      {input.designBilling === 'flat' ? 'Flat design fee' : 'Design hours, estimated'}
                    </label>
                    <input
                      id="q-dh"
                      type="number"
                      step="0.5"
                      min="0"
                      value={input.designQty}
                      onChange={num('designQty')}
                    />
                    <div className="hint">
                      {input.designBilling === 'flat'
                        ? 'Client sees one number and no clock. You carry the overrun.'
                        : `Billed as it happens at ${money0(rates.designHourly)}/h. The client approves this estimate before you start.`}
                    </div>
                  </div>
                  <div className="fld">
                    <label className="lbl" htmlFor="q-rev">
                      Revision rounds included
                    </label>
                    <input id="q-rev" type="number" min="0" value={input.revisions} onChange={num('revisions')} />
                    <div className="hint">Beyond this, revisions bill hourly at the design rate.</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="pane" style={{ margin: 0 }}>
            <h3>
              The print
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--txt-3)',
                  textTransform: 'none',
                  letterSpacing: 0,
                }}
              >
                per part × quantity
              </span>
            </h3>
            <div className="grid2">
              <div className="fld">
                <label className="lbl" htmlFor="q-qty">
                  Quantity
                </label>
                <input id="q-qty" type="number" min="1" value={input.quantity} onChange={num('quantity')} />
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="q-mat">
                  Material
                </label>
                <select id="q-mat" value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
                  {ctx.materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {/* Machine gets its own full-width row: the option labels are too
                long for a third of a row. This was a real clipping bug. */}
            <div className="fld" style={{ marginTop: 10 }}>
              <label className="lbl" htmlFor="q-mach">
                Machine
              </label>
              <select id="q-mach" value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
                {ctx.printers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.model}
                  </option>
                ))}
              </select>
              <div className="hint">
                {printer
                  ? `${money0(printer.ratePerHour)}/h machine time plus ${money0(printer.wearPerHour)}/h wear. Both lines re-price when you switch.`
                  : 'No machine on file.'}
              </div>
            </div>
            <div className="grid3" style={{ marginTop: 10 }}>
              <div className="fld">
                <label className="lbl" htmlFor="q-grams">
                  {unitWord} per part
                </label>
                <input
                  id="q-grams"
                  type="number"
                  min="0"
                  value={input.unitsPerPart}
                  onChange={num('unitsPerPart')}
                />
                <div className="hint">Slicer figure plus supports and purge.</div>
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="q-hrs">
                  Print hours per part
                </label>
                <input
                  id="q-hrs"
                  type="number"
                  step="0.25"
                  min="0"
                  value={input.printHrsPerPart}
                  onChange={num('printHrsPerPart')}
                />
                <div className="hint">From the slicer estimate.</div>
              </div>
              <div className="fld">
                <label className="lbl" htmlFor="q-post">
                  Finishing hours, all parts
                </label>
                <input
                  id="q-post"
                  type="number"
                  step="0.25"
                  min="0"
                  value={input.finishingHrs}
                  onChange={num('finishingHrs')}
                />
                <div className="hint">Support removal, sanding, wash &amp; cure, assembly.</div>
              </div>
            </div>
          </div>

          <div className="pane" style={{ margin: 0 }}>
            <h3>Adjustments</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={input.rush}
                  onChange={(e) => set('rush')(e.target.checked)}
                  style={{ marginTop: 2, width: 'auto' }}
                />
                <span>
                  <span style={{ fontSize: 13, color: 'var(--txt)', display: 'block' }}>
                    Rush job — {trimPct(rates.rushPct)}% surcharge
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                    Jumps the queue and takes a machine off whatever it is on.
                  </span>
                </span>
              </label>
              <div className="grid2">
                <div className="fld">
                  <label className="lbl" htmlFor="q-flat">
                    Flat per-item price, if agreed
                  </label>
                  <input id="q-flat" type="number" min="0" value={input.flatEach} onChange={num('flatEach')} />
                  <div className="hint">
                    Set above zero to price by the piece instead of by the build. Overrides material, machine and
                    finishing lines.
                  </div>
                </div>
                <div className="fld">
                  <label className="lbl" htmlFor="q-disc">
                    Discount %
                  </label>
                  <input
                    id="q-disc"
                    type="number"
                    min="0"
                    max="100"
                    value={input.discountPct}
                    onChange={num('discountPct')}
                  />
                  <div className="hint">Repeat-client or volume allowance.</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* --------------------------------------------------- right column */}
        <div style={{ position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--lit-edge)',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '14px 16px',
                borderBottom: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '.06em',
                    color: 'var(--txt-3)',
                  }}
                >
                  Quote
                </div>
                <div style={{ fontSize: 13, color: 'var(--txt)', marginTop: 2 }}>
                  {client || 'No client yet'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 26,
                    lineHeight: '30px',
                    fontWeight: 650,
                    color: 'var(--biolum)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {money(q.total)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2 }}>
                  {money(q.perUnit)} per part
                </div>
              </div>
            </div>

            <div style={{ padding: '12px 16px 14px' }}>
              {q.lines.map((l) => (
                <div
                  key={l.key}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    padding: '7px 0',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--txt)' }}>{l.label}</div>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 10,
                        color: 'var(--txt-3)',
                        marginTop: 1,
                      }}
                    >
                      {l.basis}
                    </div>
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      color: 'var(--txt)',
                      fontVariantNumeric: 'tabular-nums',
                      flex: 'none',
                    }}
                  >
                    {money(l.amount)}
                  </div>
                </div>
              ))}

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  padding: '10px 0 0',
                  fontSize: 12,
                }}
              >
                <span style={{ color: 'var(--txt-2)' }}>Subtotal</span>
                <span
                  style={{ fontFamily: 'var(--mono)', color: 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}
                >
                  {money(q.subtotal)}
                </span>
              </div>

              {q.adjustments.map((a) => (
                <div
                  key={a.key}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    padding: '5px 0',
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: a.ink }}>{a.label}</span>
                  <span style={{ fontFamily: 'var(--mono)', color: a.ink, fontVariantNumeric: 'tabular-nums' }}>
                    {a.sign === '-' ? '−' : '+'}
                    {money(a.amount)}
                  </span>
                </div>
              ))}

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: '1px solid var(--line-strong)',
                  fontSize: 14,
                }}
              >
                <span style={{ fontWeight: 600, color: 'var(--txt)' }}>Total due</span>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontWeight: 650,
                    color: 'var(--txt)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {money(q.total)}
                </span>
              </div>
            </div>
          </div>

          {q.deposit > 0 ? (
            <div
              style={{
                background: 'var(--panel)',
                border: '1px solid color-mix(in srgb, var(--warn) 34%, transparent)',
                borderRadius: 8,
                padding: '13px 16px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 14 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>
                  {trimPct(rates.depositPct)}%{' '}
                  {rates.depositWhen === 'print' ? 'due before printing' : 'due before design starts'}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 17,
                    fontWeight: 650,
                    color: 'var(--warn)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {money(q.deposit)}
                </span>
              </div>
              <div style={{ fontSize: 11, lineHeight: '17px', color: 'var(--txt-3)', marginTop: 5 }}>
                {q.needsDesign
                  ? 'Modelling begins once it clears. The turnaround estimate counts from that day, not from today.'
                  : 'Collected before the job is scheduled onto a machine.'}{' '}
                Balance of {money(q.balance)} on delivery.
              </div>
            </div>
          ) : (
            <div className="hint" style={{ margin: 0 }}>
              {rates.depositWhen === 'none'
                ? 'Deposits are turned off in shop settings — this one is invoiced whole on delivery.'
                : `Under the ${money0(rates.depositWaiveBelow)} deposit threshold — this one is invoiced whole on delivery.`}
            </div>
          )}

          {q.minimumApplied && (
            <div className="notice" style={{ margin: 0 }}>
              <span>
                <b>Minimum order.</b> The build works out to {money(q.rawSubtotal)}, under the{' '}
                {money0(rates.minimumOrder)} shop minimum. The quote is held at the minimum.
              </span>
            </div>
          )}

          {/* Owner-only. Never shown to a client, never printed. */}
          <div className="pane" style={{ margin: 0 }}>
            <h3>What this job costs you</h3>
            <div className="kv" style={{ gridTemplateColumns: '1fr auto', gap: '6px 12px' }}>
              <span className="k">Material at cost</span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                {money(q.materialCost)}
              </span>
              <span className="k">Machine time + wear</span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                {money(q.machineAmt + q.wearAmt)}
              </span>
              <span className="k">Your hours</span>
              <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                {money(q.yourHours)}
              </span>
              <span className="k" style={{ color: 'var(--txt-2)' }}>
                Margin after costs {q.costsIncomplete ? '(estimate)' : ''}
              </span>
              <span
                className="v"
                style={{
                  fontFamily: 'var(--mono)',
                  textAlign: 'right',
                  color:
                    q.margin < 0
                      ? 'var(--red)'
                      : q.marginPctOfTotal < 0.15
                        ? 'var(--warn)'
                        : 'var(--ok)',
                }}
              >
                {money(q.margin)}
              </span>
            </div>
            <div className="hint">
              {q.costsIncomplete
                ? "Your hours are counted at the rate you charge. Machine time is priced as break-even here because the printer's wattage or your electricity rate isn't set (Machines and Identity tabs in Settings) — the real margin is likely higher."
                : "Your hours are counted at the rate you charge, so margin here is what's left over after paying yourself."}
            </div>
          </div>

          <div className="pane" style={{ margin: 0 }}>
            <h3>Rates used</h3>
            <div className="kv" style={{ gridTemplateColumns: '1fr auto', gap: '5px 12px' }}>
              {[
                ['Design and modelling', `${money0(rates.designHourly)} / h`],
                ['Finishing labour', `${money0(rates.finishingHourly)} / h`],
                ...(printer
                  ? ([
                      [`Machine time · ${printer.name}`, `${money0(printer.ratePerHour)} / h`],
                      ['Machine wear', `${money0(printer.wearPerHour)} / h`],
                    ] as [string, string][])
                  : []),
                ...(material
                  ? ([
                      [
                        material.name,
                        material.unit === 'g'
                          ? `${money0((material.sellOverride ?? material.costPerUnit * rates.materialMarkup) * 1000)} / kg sell · ${money0(material.costPerUnit * 1000)} cost`
                          : `${money(material.sellOverride ?? material.costPerUnit * rates.materialMarkup)} / mL sell`,
                      ],
                    ] as [string, string][])
                  : []),
                ['Material markup', `cost × ${rates.materialMarkup}`],
                [
                  'Deposit',
                  rates.depositWhen === 'none'
                    ? 'none'
                    : `${trimPct(rates.depositPct)}% before ${rates.depositWhen}`,
                ],
                ['Rush surcharge', `${trimPct(rates.rushPct)}%`],
                ['Shop minimum', money0(rates.minimumOrder)],
                [rates.taxLabel, `${trimPct(rates.taxPct)}%`],
              ].map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}>
                  <span className="k">{k}</span>
                  <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
                    {v}
                  </span>
                </span>
              ))}
            </div>
            <div className="hint">
              Every one of these is a row in the database, edited on the Shop settings screen. Sending the quote freezes
              this set onto it.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
