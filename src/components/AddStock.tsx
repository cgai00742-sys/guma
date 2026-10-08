/**
 * Put material on the shelf, from wherever the shortage is noticed.
 *
 * CG, 8 Oct 2026: "I can't add material, please fix throughout the
 * program." Adding stock worked -- but only behind a "Stock" button on a
 * Settings row, under a purchase form that asks what you paid. A shop
 * looking at "0 g" in a table, or "short 744g" on a project, had nowhere
 * to type the number. This is that place, used by Settings and the
 * Scheduled spool check alike, so both write the shelf the same way.
 *
 * Two ways, because they are two different facts:
 *  - Bought more: an amount and what was paid. Logged as a purchase, so
 *    it also corrects what the material costs (the weighted average).
 *  - Counted it: what is on the shelf right now. Logged as a count, so
 *    the gap from what Guma expected stays on the record.
 * A purchase with no price is refused rather than saved at $0 -- a free
 * kilo would quietly drag the average cost of every later quote down.
 */
import { useState } from 'react'
import { recordMaterialPurchase, recordStockCount } from '../lib/data'
import { todayISO } from '../lib/dates'

export default function AddStock({
  shopId,
  actorId,
  material,
  onDone,
  compact = false,
}: {
  shopId: string
  actorId: string
  material: { id: string; name: string; unit: 'g' | 'ml'; onHand: number }
  onDone: (said: string) => void | Promise<void>
  compact?: boolean
}) {
  const big = material.unit === 'g' ? 'kg' : 'L'
  const [mode, setMode] = useState<'bought' | 'counted'>('bought')
  const [amount, setAmount] = useState('')
  const [inBig, setInBig] = useState(true)
  const [paid, setPaid] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const base = Number(amount) * (inBig ? 1000 : 1)
  const okAmount = amount.trim() !== '' && Number.isFinite(base) && (mode === 'counted' ? base >= 0 : base > 0)
  const okPaid = mode === 'counted' || (paid.trim() !== '' && Number(paid) >= 0)
  const id = `as-${material.id}`

  async function save() {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'bought') {
        await recordMaterialPurchase(shopId, material.id, actorId, {
          purchasedOn: todayISO(),
          qty: base,
          totalCost: Number(paid),
          supplier: null,
          note: null,
        })
        await onDone(`Added ${Math.round(base).toLocaleString()}${material.unit} of ${material.name}.`)
      } else {
        await recordStockCount(shopId, material.id, actorId, { countedOn: todayISO(), counted: base, note: null })
        await onDone(`${material.name} counted at ${Math.round(base).toLocaleString()}${material.unit}.`)
      }
      setAmount('')
      setPaid('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: compact ? 6 : 0 }}>
      <div className="btnrow" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
        <div className="fld" style={{ margin: 0 }}>
          <label className="lbl" htmlFor={`${id}-mode`}>
            {material.name}
          </label>
          <select id={`${id}-mode`} value={mode} onChange={(e) => setMode(e.target.value as 'bought' | 'counted')}>
            <option value="bought">I bought more</option>
            <option value="counted">I counted what is there</option>
          </select>
        </div>
        <div className="fld" style={{ margin: 0, minWidth: 140 }}>
          <label className="lbl" htmlFor={`${id}-amount`}>
            {mode === 'bought' ? 'How much came in' : 'On the shelf now'}
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id={`${id}-amount`}
              type="number"
              min="0"
              step="any"
              value={amount}
              style={{ width: 90 }}
              onChange={(e) => setAmount(e.target.value)}
            />
            <select
              aria-label="Unit"
              value={inBig ? 'big' : 'base'}
              style={{ width: 'auto' }}
              onChange={(e) => setInBig(e.target.value === 'big')}
            >
              <option value="big">{big}</option>
              <option value="base">{material.unit}</option>
            </select>
          </div>
        </div>
        {mode === 'bought' && (
          <div className="fld" style={{ margin: 0, minWidth: 120 }}>
            <label className="lbl" htmlFor={`${id}-paid`}>
              What you paid, all in
            </label>
            <input
              id={`${id}-paid`}
              type="number"
              min="0"
              step="0.01"
              value={paid}
              style={{ width: 100 }}
              onChange={(e) => setPaid(e.target.value)}
            />
          </div>
        )}
        <button type="button" className="btn sm primary" disabled={busy || !okAmount || !okPaid} onClick={() => void save()}>
          {busy ? 'Saving…' : mode === 'bought' ? 'Add to the shelf' : 'Record the count'}
        </button>
      </div>
      {!compact && (
        <div className="hint" style={{ marginTop: 4 }}>
          {mode === 'bought'
            ? 'Logged as a purchase: it adds to on hand and corrects what this material costs you.'
            : `Sets on hand to what you counted. Guma expected ${Math.round(material.onHand).toLocaleString()}${material.unit}; any difference stays on the record.`}
        </div>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  )
}
