/**
 * Shelf — the half of the business nobody was tracking.
 *
 * Guma could only ever see work somebody commissioned. A shop that prints
 * two hundred keychains and sells them at a farmers' market has spent real
 * material, real machine hours and real evenings, and taken real money, and
 * none of it existed here. For most small shops that IS the business.
 *
 * Three numbers on this screen are deliberately not the ones a seller
 * expects, and each one is the difference between a flattering figure and a
 * true one.
 *
 * WHAT IT MADE is after the platform's cut. A $12 keychain sold on Etsy is
 * not $12. Etsy takes 6.5% plus 3% + $0.25 processing plus $0.20 to list --
 * about a tenth of a $50 sale and nearly a fifth of a $5 one. A profit
 * figure that ignores that is wrong in the direction that feels best.
 *
 * ON THE SHELF is money already spent that has not come back. Making two
 * hundred and selling twelve is not a loss of a hundred and eighty units;
 * it is twelve units of profit and a shelf full of cash. Those are
 * different problems with different answers, so they are different numbers.
 *
 * DESIGN IS A PAYBACK, not a per-unit cost. The evening spent designing the
 * thing is either recovered or it is not. Smearing it across a per-unit
 * figure means the denominator grows with every batch, and last month's
 * number quietly becomes wrong -- see 0014_selling.sql.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  deleteBatch,
  deleteProduct,
  listJobs,
  deleteSale,
  listChannels,
  saveChannel,
  listSales,
  listShelf,
  recordSale,
  saveBatch,
  saveProduct,
  type ChannelInput,
  type ChannelRow,
  type ProductRow,
  type SaleRow,
  type ShopContext,
} from '../lib/data'
import { makeMoney } from '../lib/pricing'
import { productResult, summarize, type BatchStock, type ProductResult } from '../lib/selling'
import { todayISO } from '../lib/dates'
import { Flash, useFlash } from '../components/Saving'

/** The rows the pure module wants, out of the rows the database gives. */
function stockOf(products: ProductRow[]): BatchStock[] {
  return products.flatMap((p) =>
    p.batches.map((b) => ({
      batchId: b.id,
      productId: p.id,
      unitsMade: Number(b.units_made),
      unitsSold: Number(b.units_sold),
      unitsLeft: Number(b.units_left),
      unitCost: Number(b.unit_cost),
      revenue: Number(b.revenue),
      fees: Number(b.fees),
      costOfSold: Number(b.cost_of_sold),
      madeOn: b.made_on,
    })),
  )
}

export default function Shelf({ ctx }: { ctx: ShopContext }) {
  const [products, setProducts] = useState<ProductRow[] | null>(null)
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [sales, setSales] = useState<SaleRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [selling, setSelling] = useState<{ batchId: string; left: number; name: string } | null>(null)
  const [flash, setFlash] = useFlash()
  /** Project titles, so each batch can say which project made it. */
  const [jobTitles, setJobTitles] = useState<Record<string, string>>({})
  /** The batch or product being removed, waiting for a yes. */
  const [removing, setRemoving] = useState<string | null>(null)

  const { money } = useMemo(
    () => makeMoney(ctx.shop.currency, ctx.shop.locale),
    [ctx.shop.currency, ctx.shop.locale],
  )

  const reload = useCallback(async () => {
    try {
      const [p, c, s] = await Promise.all([
        listShelf(ctx.shop.id),
        listChannels(ctx.shop.id),
        listSales(ctx.shop.id),
      ])
      setProducts(p)
      setChannels(c)
      setSales(s)
      setError(null)
      listJobs(ctx.shop.id)
        .then((js) => setJobTitles(Object.fromEntries(js.map((j) => [j.jobId, j.title]))))
        .catch(() => undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [ctx.shop.id])

  useEffect(() => {
    void reload()
  }, [reload])

  const results: ProductResult[] = useMemo(() => {
    if (!products) return []
    const stock = stockOf(products)
    return products
      .filter((p) => !p.archived)
      .map((p) =>
        productResult(
          { id: p.id, name: p.name, designCost: p.design_cost === null ? null : Number(p.design_cost) },
          stock,
        ),
      )
  }, [products])

  const total = useMemo(() => summarize(results), [results])

  async function addProduct(name: string, units: number, unitCost: number, note: string) {
    setBusy(true)
    setError(null)
    try {
      const productId = await saveProduct(ctx.shop.id, { name })
      if (units > 0) {
        await saveBatch(ctx.shop.id, {
          productId,
          unitsMade: units,
          unitCost,
          madeOn: todayISO(),
          note: note.trim() || null,
        })
      }
      await reload()
      setAdding(false)
      setOpenId(productId)
      setFlash(`${name.trim()} added.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function sell(batchId: string, channelId: string | null, units: number, unitPrice: number) {
    setBusy(true)
    setError(null)
    try {
      await recordSale(ctx.shop.id, { batchId, channelId, units, unitPrice, soldOn: todayISO() })
      await reload()
      setSelling(null)
      setFlash(`${units} sold.`)
    } catch (e) {
      // recordSale's refusals carry the number that matters -- how many are
      // actually left -- so they are shown as written.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function editChannel(next: ChannelInput) {
    setBusy(true)
    setError(null)
    try {
      await saveChannel(ctx.shop.id, next)
      await reload()
      setFlash(`${next.name.trim()} saved.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function removeBatch(batchId: string) {
    setBusy(true)
    try {
      await deleteBatch(ctx.shop.id, batchId)
      setRemoving(null)
      await reload()
      setFlash('Batch taken off the shelf. Its pieces are back in their project, ready to place again.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function removeProduct(productId: string, name: string) {
    setBusy(true)
    try {
      await deleteProduct(ctx.shop.id, productId)
      setRemoving(null)
      setOpenId(null)
      await reload()
      setFlash(`${name} deleted.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function undoSale(saleId: string) {
    setBusy(true)
    try {
      await deleteSale(ctx.shop.id, saleId)
      await reload()
      setFlash('Sale removed, units back on the shelf.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 32 }}>
      <div className="section-head">
        <div>
          <h2>Shelf</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            {products
              ? `${total.unitsMade} made · ${total.unitsSold} sold · ${money(total.grossProfit)} kept · ${money(total.stockAtCost)} still on the shelf`
              : 'Loading…'}
          </div>
        </div>
        <button
          type="button"
          className="btn primary"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? 'Cancel' : 'Add something you make'}
        </button>
      </div>

      {adding && <NewProduct busy={busy} money={money} onAdd={addProduct} />}

      <Flash message={flash} />

      {error && (
        <div className="alert" style={{ marginBottom: 8 }}>
          <span>{error}</span>
        </div>
      )}

      {products && results.length === 0 && !adding && (
        <div className="pane">
          <h3>Nothing on the shelf yet</h3>
          <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--txt-2)', maxWidth: 560 }}>
            This is the selling half of the business — the things you make for yourself and sell,
            rather than work somebody ordered. Add what you already have on hand, or record what an
            in-house project produced from the project itself.
          </div>
          <div className="guide" style={{ marginTop: 12, maxWidth: 560 }}>
            <div className="guide-g">
              <div className="guide-h"><span className="guide-tag">What you get</span></div>
              <div className="guide-kv">
                <div className="guide-r"><span className="k">What a market day actually made, after the stall's cut</span></div>
                <div className="guide-r"><span className="k">How much of your money is sitting in unsold stock</span></div>
                <div className="guide-r"><span className="k">Whether an evening of design has paid for itself yet</span></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="pane" style={{ padding: 0, overflow: 'hidden' }}>
          <table>
            <thead>
              <tr>
                <th>What you make</th>
                <th className="r">Made</th>
                <th className="r">Sold</th>
                <th className="r">Left</th>
                <th className="r">Took in</th>
                <th className="r">Fees</th>
                <th className="r">Kept</th>
                <th className="r">On the shelf</th>
                <th>Design</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const product = products?.find((p) => p.id === r.productId)
                const open = openId === r.productId
                return (
                  <Fragment key={r.productId}>
                    <tr
                      className="row click"
                      onClick={() => setOpenId(open ? null : r.productId)}
                    >
                      <td>{r.name}</td>
                      <td className="r">{r.unitsMade}</td>
                      <td className="r">{r.unitsSold}</td>
                      <td className="r">{r.unitsLeft}</td>
                      <td className="r">{money(r.revenue)}</td>
                      <td className="r">{r.fees > 0 ? `−${money(r.fees)}` : '—'}</td>
                      <td className={`r ${r.grossProfit < 0 ? 'neg' : 'pos'}`}>{money(r.grossProfit)}</td>
                      <td className="r">{money(r.stockAtCost)}</td>
                      <td>
                        <Payback result={r} money={money} />
                      </td>
                    </tr>
                    {open && product && (
                      <tr>
                        <td colSpan={9} style={{ background: 'var(--panel-2)' }}>
                          <Batches
                            product={product}
                            sales={sales}
                            money={money}
                            busy={busy}
                            onSell={(batchId, left) =>
                              setSelling({ batchId, left, name: product.name })
                            }
                            onUndo={undoSale}
                            jobTitles={jobTitles}
                            removing={removing}
                            onAskRemove={setRemoving}
                            onRemoveBatch={(id) => void removeBatch(id)}
                            onRemoveProduct={() => void removeProduct(product.id, product.name)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {products && (
        <Channels
          channels={channels.filter((c) => !c.archived)}
          money={money}
          busy={busy}
          onSave={editChannel}
        />
      )}

      {selling && (
        <SellDialog
          name={selling.name}
          left={selling.left}
          channels={channels.filter((c) => !c.archived)}
          money={money}
          busy={busy}
          onCancel={() => setSelling(null)}
          onSell={(channelId, units, price) => sell(selling.batchId, channelId, units, price)}
        />
      )}
    </div>
  )
}

/**
 * Whether the evening spent designing it has come back yet.
 *
 * Stated as a fraction of a real figure rather than as a bar, because
 * "$310 of $495" is a sentence a person can act on and a progress bar is
 * a feeling.
 */
function Payback({ result, money }: { result: ProductResult; money: (n: number) => string }) {
  if (result.designCost === null) {
    return <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>not tracked</span>
  }
  if (result.designPaidBack) {
    return (
      <span className="tag pos" style={{ fontSize: 11 }}>
        paid back
      </span>
    )
  }
  return (
    <span style={{ fontSize: 11, color: 'var(--txt-2)' }}>
      {money(Math.max(0, result.grossProfit))} of {money(result.designCost)}
    </span>
  )
}

/** The batches behind one product, newest first, with what each has done. */
function Batches({
  product,
  sales,
  money,
  busy,
  onSell,
  onUndo,
  jobTitles = {},
  removing = null,
  onAskRemove = () => undefined,
  onRemoveBatch = () => undefined,
  onRemoveProduct = () => undefined,
}: {
  product: ProductRow
  sales: SaleRow[]
  money: (n: number) => string
  busy: boolean
  onSell: (batchId: string, left: number) => void
  onUndo: (saleId: string) => void
  jobTitles?: Record<string, string>
  removing?: string | null
  onAskRemove?: (id: string | null) => void
  onRemoveBatch?: (batchId: string) => void
  onRemoveProduct?: () => void
}) {
  if (product.batches.length === 0) {
    return (
      <div style={{ padding: '10px 2px', fontSize: 12, color: 'var(--txt-2)' }}>
        Nothing on the shelf. Pieces come here from an in-house project&rsquo;s <b>Made</b> section — pick
        them and send them to the shelf — so the cost is what the prints really cost.
        <div style={{ marginTop: 8 }}>
          {removing === product.id ? (
            <>
              Delete {product.name}?{' '}
              <button type="button" className="btn sm danger" disabled={busy} onClick={onRemoveProduct}>
                Delete it
              </button>{' '}
              <button type="button" className="btn sm" onClick={() => onAskRemove(null)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="linkbtn" style={{ width: 'auto', fontSize: 11 }} onClick={() => onAskRemove(product.id)}>
              delete this product
            </button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div style={{ padding: '10px 2px' }}>
      {product.batches.map((b) => {
        const mine = sales.filter((s) => s.batch_id === b.id)
        return (
          <div key={b.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>
                {b.units_made} made {b.made_on}
              </b>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)' }}>
                {money(Number(b.unit_cost))} each · {b.units_left} left
              </span>
              {b.estimated && (
                <span className="tag warn" style={{ fontSize: 10 }} title="No project behind this batch, so the cost is what somebody typed rather than what the runs and hours came to.">
                  cost estimated
                </span>
              )}
              {/* Where it came from, one click away (CG, 22 Oct: the Shelf and
                  the project should talk to each other). */}
              {b.job_id && (
                <Link to={`/project/${b.job_id}`} style={{ fontSize: 11 }}>
                  from {jobTitles[b.job_id] ?? 'its project'} →
                </Link>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={busy || Number(b.units_left) < 1}
                style={{ marginLeft: 'auto' }}
                onClick={() => onSell(b.id, Number(b.units_left))}
              >
                {Number(b.units_left) < 1 ? 'All sold' : 'Record a sale'}
              </button>
              {mine.length === 0 &&
                (removing === b.id ? (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
                    Take it off the shelf?
                    <button type="button" className="btn sm danger" disabled={busy} onClick={() => onRemoveBatch(b.id)}>
                      Remove it
                    </button>
                    <button type="button" className="btn sm" onClick={() => onAskRemove(null)}>
                      Keep it
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="linkbtn"
                    style={{ width: 'auto', fontSize: 11 }}
                    aria-label={`Remove the batch of ${b.made_on}`}
                    disabled={busy}
                    onClick={() => onAskRemove(b.id)}
                  >
                    remove
                  </button>
                ))}
            </div>
            {b.note && (
              <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2 }}>{b.note}</div>
            )}
            {mine.length > 0 && (
              <div className="guide" style={{ marginTop: 6 }}>
                <div className="guide-g">
                  <div className="guide-kv">
                    {mine.map((s) => (
                      <div className="guide-r" key={s.id}>
                        <span className="k">
                          {s.units} at {money(Number(s.unit_price))}
                          {s.channel_name ? ` · ${s.channel_name}` : ''} · {s.sold_on}
                        </span>
                        <span className="v">
                          {money(Number(s.units) * Number(s.unit_price) - Number(s.fee_total))}
                          <button
                            type="button"
                            className="addnote"
                            style={{ marginLeft: 8 }}
                            disabled={busy}
                            onClick={() => onUndo(s.id)}
                          >
                            remove
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Something the shop already has on hand. No job behind it, and the screen
 *  says so rather than dressing a guess up as a measurement. */
function NewProduct({
  busy,
  money,
  onAdd,
}: {
  busy: boolean
  money: (n: number) => string
  onAdd: (name: string, units: number, unitCost: number, note: string) => void
}) {
  const [name, setName] = useState('')
  const [units, setUnits] = useState('')
  const [cost, setCost] = useState('')
  const [note, setNote] = useState('')
  const n = Number(units) || 0
  const c = Number(cost) || 0

  return (
    <div className="pane">
      <h3>Something you make</h3>
      <div className="grid3">
        <div className="fld">
          <label className="lbl" htmlFor="sp-name">What is it</label>
          <input id="sp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hex keychain" />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor="sp-units">How many on hand</label>
          <input id="sp-units" type="number" min="0" step="1" value={units} onChange={(e) => setUnits(e.target.value)} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor="sp-cost">What one cost to make</label>
          <input id="sp-cost" type="number" min="0" step="any" value={cost} onChange={(e) => setCost(e.target.value)} />
          <div className="hint">Your best figure. Nothing is checking it.</div>
        </div>
      </div>
      <div className="fld" style={{ marginTop: 8 }}>
        <label className="lbl" htmlFor="sp-note">Note (optional)</label>
        <input id="sp-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Made last winter, before Guma" />
      </div>
      {n > 0 && c > 0 && (
        <div className="guide" style={{ marginTop: 10 }}>
          <div className="guide-g">
            <div className="guide-h"><span className="guide-tag">Yours</span></div>
            <div className="guide-kv">
              <div className="guide-r">
                <span className="k">Money already in this shelf</span>
                <span className="v">{money(n * c)}</span>
              </div>
            </div>
            <div className="guide-note">
              Typed, not measured — there is no project behind it, so Guma marks it as an estimate.
              A batch recorded from an in-house project carries the real runs and hours instead.
            </div>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !name.trim()}
          onClick={() => onAdd(name, n, c, note)}
        >
          {busy ? 'Saving…' : 'Add it'}
        </button>
      </div>
    </div>
  )
}

/** Units leaving, at a price, through a place that takes a cut. */
function SellDialog({
  name,
  left,
  channels,
  money,
  busy,
  onCancel,
  onSell,
}: {
  name: string
  left: number
  channels: ChannelRow[]
  money: (n: number) => string
  busy: boolean
  onCancel: () => void
  onSell: (channelId: string | null, units: number, unitPrice: number) => void
}) {
  const [units, setUnits] = useState('1')
  const [price, setPrice] = useState('')
  const [channelId, setChannelId] = useState<string>('')

  const n = Number(units) || 0
  const p = Number(price) || 0
  const channel = channels.find((c) => c.id === channelId)
  const fee = channel ? (n * p * Number(channel.fee_pct)) / 100 + Number(channel.fee_flat) : 0

  return (
    <div className="pane" style={{ position: 'sticky', bottom: 12, marginTop: 12 }}>
      <h3>
        Sold some {name}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--txt-3)', textTransform: 'none', letterSpacing: 0 }}>
          {left} on the shelf
        </span>
      </h3>
      <div className="grid3">
        <div className="fld">
          <label className="lbl" htmlFor="sd-units">How many</label>
          <input id="sd-units" type="number" min="1" max={left} step="1" value={units} onChange={(e) => setUnits(e.target.value)} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor="sd-price">Price each</label>
          <input id="sd-price" type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor="sd-channel">Where</label>
          <select id="sd-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">Direct — nobody takes a cut</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      {n > 0 && p > 0 && (
        <div className="guide" style={{ marginTop: 10 }}>
          <div className="guide-g">
            <div className="guide-h"><span className="guide-tag">Yours</span></div>
            <div className="guide-kv">
              <div className="guide-r">
                <span className="k">They pay</span>
                <span className="v">{money(n * p)}</span>
              </div>
              {channel && (
                <div className="guide-r">
                  <span className="k">{channel.name} takes</span>
                  <span className="v">−{money(fee)}</span>
                </div>
              )}
              <div className="guide-r">
                <span className="k">You keep</span>
                <span className="v">{money(n * p - fee)}</span>
              </div>
            </div>
            {channel && (
              <div className="guide-note">
                {Number(channel.fee_pct)}% plus {money(Number(channel.fee_flat))} a sale. Stored with
                this sale, so a fee change next year cannot rewrite what today made.
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || n < 1 || n > left || !(p >= 0) || price.trim() === ''}
          style={{ marginLeft: 'auto' }}
          onClick={() => onSell(channelId || null, n, p)}
        >
          {busy ? 'Saving…' : 'Record it'}
        </button>
      </div>
    </div>
  )
}

/**
 * Where the shop sells, and what each place takes.
 *
 * The fee lives on the channel rather than on each sale because a fee
 * somebody has to remember to work out is a fee that gets left at zero, and
 * then every profit figure is wrong in the flattering direction. It is
 * editable here, in front of the numbers it moves, rather than buried in
 * settings: a channel showing "takes nothing" beside real sales is a
 * question a person will actually stop and answer.
 */
function Channels({
  channels,
  money,
  busy,
  onSave,
}: {
  channels: ChannelRow[]
  money: (n: number) => string
  busy: boolean
  onSave: (next: ChannelInput) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [pct, setPct] = useState('')
  const [flat, setFlat] = useState('')

  function start(c: ChannelRow | null) {
    setEditing(c ? c.id : 'new')
    setName(c ? c.name : '')
    setPct(c ? String(Number(c.fee_pct)) : '')
    setFlat(c ? String(Number(c.fee_flat)) : '')
  }

  return (
    <div className="pane" style={{ marginTop: 12 }}>
      <h3>
        Where you sell
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--txt-3)', textTransform: 'none', letterSpacing: 0 }}>
          what each place takes
        </span>
      </h3>

      {channels.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--txt-2)', marginBottom: 10 }}>
          Nowhere set up yet. A sale can still be recorded as direct — this is only for the places
          that take a cut of it.
        </div>
      )}

      <div className="guide" style={{ marginTop: 0 }}>
        {channels.map((c) => (
          <div className="guide-g" key={c.id}>
            <div className="guide-h">
              <span className={Number(c.fee_pct) === 0 && Number(c.fee_flat) === 0 ? 'guide-tag' : 'guide-tag alt'}>
                {Number(c.fee_pct) === 0 && Number(c.fee_flat) === 0 ? 'Takes nothing' : 'Takes'}
              </span>
              <button type="button" className="addnote" style={{ marginLeft: 'auto' }} onClick={() => start(c)}>
                edit
              </button>
            </div>
            <div className="guide-kv">
              <div className="guide-r">
                <span className="k">{c.name}</span>
                <span className="v">
                  {Number(c.fee_pct) === 0 && Number(c.fee_flat) === 0
                    ? '—'
                    : `${Number(c.fee_pct)}% + ${money(Number(c.fee_flat))}`}
                </span>
              </div>
            </div>
            {Number(c.fee_pct) === 0 && Number(c.fee_flat) === 0 && (
              <div className="guide-note">
                Nothing subtracted from a sale here yet. If this place does take a cut, every profit
                figure through it is reading high until you say so.
              </div>
            )}
          </div>
        ))}
      </div>

      {editing === null ? (
        <button type="button" className="btn sm" style={{ marginTop: 10 }} onClick={() => start(null)}>
          Add a place you sell
        </button>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div className="grid3">
            <div className="fld">
              <label className="lbl" htmlFor="ch-name">Called</label>
              <input id="ch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Etsy" />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="ch-pct">Takes (%)</label>
              <input id="ch-pct" type="number" min="0" max="100" step="any" value={pct} onChange={(e) => setPct(e.target.value)} />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="ch-flat">Plus, per sale</label>
              <input id="ch-flat" type="number" min="0" step="any" value={flat} onChange={(e) => setFlat(e.target.value)} />
              <div className="hint">Listing and processing fees that do not scale.</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !name.trim()}
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                onSave({
                  ...(editing === 'new' ? {} : { id: editing }),
                  name,
                  feePct: Number(pct) || 0,
                  feeFlat: Number(flat) || 0,
                })
                setEditing(null)
              }}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
