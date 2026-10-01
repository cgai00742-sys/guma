/**
 * New project — the shortest path from "someone asked" to a price.
 *
 * This is deliberately the SIMPLEST page in Guma, and it got simpler on
 * purpose. Two things were cut:
 *
 *  - The seven-stage rail across the top. It was in the original design
 *    when intake was the only screen that existed, so it had to hint at a
 *    process that was not built yet. Now that process is real and lives on
 *    the project page, where the current stage, its gate and its flags are
 *    all actionable. Showing it here just told someone filling in a form
 *    about six stages they cannot do anything about.
 *  - Four stacked panes down to two. Everything needed to produce a price
 *    is visible; everything that fine-tunes one — extra contact details,
 *    flat-fee billing, revision rounds, per-item overrides, discounts —
 *    sits behind one "More options" disclosure. A shop quoting a repeat
 *    job should be able to fill this in without scrolling.
 *
 * Layout is otherwise the design's (design/Job Intake & Quote.dc.html): a
 * minmax(0,1fr) 420px grid with a sticky quote column on the right. Calm
 * register throughout — the ONLY lit element on the screen is the quote
 * card's --lit-edge border, and the only --biolum is the total, because a
 * live-updating price is genuinely live.
 *
 * No arithmetic lives in this file. Every figure comes from priceQuote().
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  buildRatesSnapshot,
  makeMoney,
  priceQuote,
  trimPct,
  type AssetOrigin,
  type DesignBilling,
  type PricedQuote,
  type QuoteInputs,
} from '../lib/pricing'
import {
  ceilingCheck,
  createInHouseJob,
  listClients,
  listSeries,
  type SeriesRow,
  loadProjectDetail,
  nextJobRef,
  saveQuote,
  takeProjectIn,
  toRateSet,
  CHANGE_CAUSES,
  CHANGE_CAUSE_LABEL,
  CEILING_PCT,
  type ChangeCause,
  type ClientRow,
  type ShopContext,
} from '../lib/data'
import { addDaysISO } from '../lib/dates'
import { seriesPath } from '../lib/series'
import { normalise, search } from '../lib/search'
import { clientItem } from '../lib/searchItems'

const ASSET_NOTES: Record<AssetOrigin, string> = {
  model:
    'You build the model from scratch — measurements, CAD, test print, fit check. This is most projects, and it is the biggest line on the quote.',
  fix: "Client sent a file that won't print as-is: wall thickness, non-manifold geometry, orientation, or a scale that has to be resolved before slicing.",
  ready: 'A print-ready file you only have to slice. No design line on the quote.',
}

const SOURCES = ['Word of mouth', 'Repeat client', 'Referral', 'Walk-in', 'Website enquiry']

/** The sentinel the client picker uses for work with no client. Not a
 *  client name: picking it switches this screen into in-house mode, where
 *  there is nothing to price and nobody to bill. */
const IN_HOUSE = '\u0000in-house'

/** A whole pane as one choice. Left-aligned because it is a sentence to
 *  read, not a label on a button. */
const PICK: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  cursor: 'pointer',
  font: 'inherit',
}

export default function Intake({ ctx }: { ctx: ShopContext }) {
  const navigate = useNavigate()
  const rates = useMemo(() => toRateSet(ctx.rateCard, ctx.shop), [ctx.rateCard, ctx.shop])
  const { money, money0 } = useMemo(
    () => makeMoney(rates.currency, rates.locale),
    [rates.currency, rates.locale],
  )

  /**
   * The shop's existing clients, so a repeat job attaches to the client it
   * belongs to instead of creating a near-duplicate from a slightly
   * different spelling. saveQuote matches on the name, so "Hafen GmbH" and
   * "Hafen Gmbh" were two clients, each holding half the ledger.
   */
  const [clients, setClients] = useState<ClientRow[]>([])
  useEffect(() => {
    listClients(ctx.shop.id)
      .then(setClients)
      .catch(() => setClients([]))
  }, [ctx.shop.id])

  const [ref, setRef] = useState<string>('…')
  /**
   * Revising an existing project's quote rather than opening a new one.
   *
   * Scope changes after a client has said yes, and a shop with no way to
   * record that keeps the new number somewhere the tool cannot see -- which
   * is how quoted-versus-actual quietly stops meaning anything. A revision
   * is a NEW VERSION against the same job: the accepted one stays exactly
   * as the client saw it, and above accepted + 10% this screen makes you
   * say what the client changed.
   */
  const [params] = useSearchParams()
  const reviseJobId = params.get('revise')
  /**
   * Which program a new piece of the shop's own work goes into -- Fiji
   * inside BathyTopo. Asked here, at the start, because creating a project
   * and then hunting for it to link it was the long way round. ?within=
   * preselects it when arriving from a program's own page.
   */
  const [within, setWithin] = useState<string>(params.get('within') ?? '')
  // Since 0026 the shop's own work is filed in a SERIES, not under another
  // project. ?within= now names a series.
  const [seriesList, setSeriesList] = useState<SeriesRow[]>([])
  useEffect(() => {
    listSeries(ctx.shop.id)
      .then((rows) => setSeriesList(rows.filter((r) => !r.archivedAt)))
      .catch(() => setSeriesList([]))
  }, [ctx.shop.id])
  const [acceptedTotal, setAcceptedTotal] = useState<number | null>(null)
  const [cause, setCause] = useState<ChangeCause>('added_work')
  const [why, setWhy] = useState('')

  useEffect(() => {
    if (reviseJobId) return
    nextJobRef(ctx.shop.id).then(setRef).catch(() => setRef('GUMA-DRAFT'))
  }, [ctx.shop.id, reviseJobId])

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

  // Load the project being revised: its client, its details and the exact
  // inputs of its newest quote, so a revision starts from what was priced
  // rather than from an empty form somebody has to reconstruct.
  useEffect(() => {
    if (!reviseJobId) return
    let live = true
    loadProjectDetail(ctx.shop.id, reviseJobId)
      .then((d) => {
        if (!live) return
        setRef(d.ref)
        setClient(d.client.name)
        setContact(d.client.contact ?? '')
        setEmail(d.client.email ?? '')
        setPhone(d.client.phone ?? '')
        setTitle(d.title)
        setBrief(d.brief ?? '')
        setNeededBy(d.facts.neededBy ?? '')
        setAcceptedTotal(d.quote?.status === 'accepted' ? d.quote.total : null)
        const q = d.quoteInputs
        if (q) {
          setInput({
            assetOrigin: d.assetOrigin,
            // 'none' is not an input here: it is what the form SAYS when
            // the asset origin is "ready to print", and persist() writes it
            // back. Keeping the last billable choice means flipping the
            // origin back does not silently zero the design line.
            designBilling: q.designBilling === 'none' ? 'hourly' : q.designBilling,
            designQty: q.designQty,
            revisions: q.revisionsIncl,
            quantity: q.quantity,
            unitsPerPart: q.unitsPerPart,
            printHrsPerPart: q.printHrsPart,
            finishingHrs: q.finishingHrs,
            rush: q.rush,
            flatEach: q.flatEach,
            discountPct: q.discountPct,
          })
          if (q.materialId) setMaterialId(q.materialId)
          if (q.printerId) setPrinterId(q.printerId)
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [ctx.shop.id, reviseJobId])

  /**
   * Who this job is for, asked before anything else.
   *
   * This used to be the second entry in a client dropdown -- and that
   * dropdown only rendered when the shop ALREADY HAD CLIENTS. On a new
   * shop there are none, so the in-house option did not exist at all, and
   * the only way to record a test print was to invent a client called
   * "In-house" that then sat in the client list forever counting as a
   * customer with a receivable. A brand-new shop is exactly the shop most
   * likely to be printing its own things.
   *
   * So it is the first question now, and nothing else renders until it is
   * answered. That is not only a bug fix: for most shops using this, their
   * own work IS the business, and burying it inside a field labelled
   * "Client" said the opposite.
   */
  // Arriving from a program's page with ?within= means it is the shop's own
  // work already -- asking "who is this for" again would be a question with
  // one answer.
  const [whoFor, setWhoFor] = useState<'client' | 'inhouse' | null>(() =>
    params.get('within') ? 'inhouse' : null,
  )
  const inHouse = whoFor === 'inhouse'

  function chooseWho(next: 'client' | 'inhouse') {
    setWhoFor(next)
    // The client field is still the mechanism underneath; the sentinel is
    // what persist() and every field below already read.
    setClient(next === 'inhouse' ? IN_HOUSE : '')
    setError(null)
  }
  const [saving, setSaving] = useState<'idle' | 'draft' | 'intake' | 'send' | 'inhouse'>('idle')
  const [error, setError] = useState<string | null>(null)

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
  // In-house work needs a title and nothing else. There is no client to
  // name and no quote to price, and every extra requirement here is a
  // reason not to log the ten-minute experiment that, forty times over, is
  // where the month actually went.
  const canSave = title.trim().length > 0 && (inHouse || client.trim().length > 0)

  /**
   * Three ways out, because there are three different intentions.
   *
   *   draft   Park it. Priced and findable, but off the board -- a price
   *           worked out while the client is still on the phone is not a
   *           job you have agreed to do.
   *   intake  Take it in. It becomes a live project at the Intake stage
   *           and starts moving through the gates.
   *   send    Take it in and open the printable, because handing a client
   *           a quote is itself the act of committing to it.
   */
  async function persist(mode: 'draft' | 'intake' | 'send' | 'inhouse') {
    if (!canSave) {
      setError(
        inHouse
          ? 'Give it a title — what are you working on?'
          : 'A client name and a project title are needed before this can be saved.',
      )
      return
    }
    setSaving(mode)
    setError(null)

    // In-house work takes the short path: there is no quote to price, no
    // client to create and no rates to freeze, so none of the machinery
    // below applies. It lands straight on the board at design.
    if (mode === 'inhouse') {
      try {
        const jobId = await createInHouseJob(ctx.shop.id, {
          title: title.trim(),
          brief,
          seriesId: within || null,
        })
        navigate(`/project/${jobId}`)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setSaving('idle')
      }
      return
    }

    try {


      const saved = await saveQuote({
        shopId: ctx.shop.id,
        ref,
        reviseJobId: reviseJobId ?? undefined,
        change: reviseJobId ? { cause, reason: why.trim() } : undefined,
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
                // Local calendar date: a quote that expires a day early because
                // the shop is west of Greenwich is a quote the client argues about.
                valid_until: addDaysISO(ctx.shop.quote_valid_days),
              }
            : undefined,
      })

      // Both paths land on the project. Intake's job ends the moment a
      // project exists; everything after that -- the stage, its gate, the
      // money, the build -- lives on the project page, and leaving someone
      // on a form (or in a print view whose only exit was back to the form)
      // is why a project could be saved and then never found again.
      // Anything but a parked draft is a real project from this moment.
      if (mode !== 'draft') {
        await takeProjectIn(ctx.shop.id, saved.jobId, ctx.profile.id)
      }
      navigate(`/project/${saved.jobId}${mode === 'send' ? '?quote=1' : ''}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving('idle')
    }
  }

  /**
   * One question, and nothing else on screen until it is answered.
   *
   * Not a toggle above a form: a toggle invites somebody to start filling
   * in a client's details and discover halfway down that they picked the
   * wrong kind. The two paths ask genuinely different questions -- one
   * prices a quote, the other does not exist -- so the fork comes first.
   */
  if (whoFor === null) {
    return (
      <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40, maxWidth: 720 }}>
        <div className="section-head">
          <div>
            <h2>New project</h2>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
              {ref} · opened today · {ctx.profile.full_name}
            </div>
          </div>
        </div>

        <h3 style={{ fontSize: 18, lineHeight: '24px', margin: '4px 0 14px' }}>
          Who is this one for?
        </h3>

        <button type="button" className="pane" onClick={() => chooseWho('inhouse')} style={PICK}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--txt)' }}>
            It is mine
          </div>
          <div style={{ fontSize: 12.5, lineHeight: '18px', color: 'var(--txt-2)', marginTop: 4 }}>
            A test print, a prototype, something you are designing to sell. Nobody is paying for it,
            so there is no quote and no invoice — you log what it takes, and Guma tells you what your
            own work costs and what it put on the shelf.
          </div>
        </button>

        <button type="button" className="pane" onClick={() => chooseWho('client')} style={PICK}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--txt)' }}>
            Someone is paying for it
          </div>
          <div style={{ fontSize: 12.5, lineHeight: '18px', color: 'var(--txt-2)', marginTop: 4 }}>
            A commissioned job. Guma prices it, freezes the rates onto the quote when you send it,
            and follows the deposit and the balance through to handover.
          </div>
        </button>
      </div>
    )
  }

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <div className="section-head">
        <div>
          <h2>
            {reviseJobId ? 'Revising the quote' : inHouse ? 'Something of my own' : 'New project'}
          </h2>
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
              {canSave
                ? 'Ready to save'
                : inHouse
                  ? 'Pending — needs a title'
                  : 'Pending — needs a client and project title'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {reviseJobId ? (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => persist('draft')}
                disabled={saving !== 'idle' || !canSave}
                title="Saves the new price as the next version, without a printable."
              >
                {saving === 'draft' ? 'Saving…' : 'Save revision'}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => persist('send')}
                disabled={saving !== 'idle' || !canSave}
                title="Saves the next version and opens the printable to send them."
              >
                {saving === 'send' ? 'Preparing…' : 'Save revision as PDF'}
              </button>
            </>
          ) : inHouse ? (
            <button
              type="button"
              className="btn primary"
              onClick={() => persist('inhouse')}
              disabled={saving !== 'idle' || !canSave}
              title={
                canSave
                  ? 'Starts it as in-house work. No quote, no client, no invoice — record what it takes as you go.'
                  : 'Give it a title first.'
              }
            >
              {saving === 'inhouse' ? 'Starting…' : 'Start it'}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => persist('draft')}
                disabled={saving !== 'idle' || !canSave}
                title={
                  canSave
                    ? 'Saves the price and the details, and leaves it off the board. Nothing is committed to.'
                    : 'Add a client name and a project title first.'
                }
              >
                {saving === 'draft' ? 'Saving…' : 'Save draft'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => persist('send')}
                disabled={saving !== 'idle' || !canSave}
                title={
                  canSave
                    ? "Takes it in and opens the printable. Freezes today's rates onto the quote, so a later rate change can never move a number the client is holding. Guma doesn't email anything — the PDF is yours to send however you like."
                    : 'Add a client name and a project title first.'
                }
              >
                {saving === 'send' ? 'Preparing…' : 'Save as PDF'}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => persist('intake')}
                disabled={saving !== 'idle' || !canSave}
                title={
                  canSave
                    ? 'Takes it in as a real project. It lands on the board at Intake and starts working through the gates.'
                    : 'Add a client name and a project title first.'
                }
              >
                {saving === 'intake' ? 'Taking in…' : 'Intake →'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* The ceiling. Shown while the numbers are being changed, not after
          the save is refused: a price that is already too high is the one
          thing the person needs to know BEFORE they finish typing. Warn,
          don't block -- CG's decision, and the right one, because a shop
          that cannot record what actually happened keeps a second set of
          numbers somewhere Guma will never see. */}
      {reviseJobId && acceptedTotal != null && (
        <RevisionCeiling
          acceptedTotal={acceptedTotal}
          total={q.total}
          money={money}
          cause={cause}
          setCause={setCause}
          why={why}
          setWhy={setWhy}
        />
      )}

      {error && (
        <div className="alert">
          <span>{error}</span>
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
            <h3>The job</h3>
            <div className="grid2">
              <div className="fld">
                <label className="lbl" htmlFor="q-client">
                  {inHouse ? 'Who it is for' : 'Client *'}
                </label>
                {!inHouse && clients.length > 0 && (
                  <select
                    aria-label="Pick an existing client"
                    value={clients.some((c) => c.name === client) ? client : ''}
                    style={{ marginBottom: 6 }}
                    onChange={(e) => {
                      const hit = clients.find((c) => c.name === e.target.value)
                      setClient(e.target.value)
                      // Their details come with them: a repeat client should
                      // not have their phone number retyped every job, and
                      // retyping is where a second spelling comes from.
                      if (hit) {
                        setContact(hit.contact ?? '')
                        setEmail(hit.email ?? '')
                        setPhone(hit.phone ?? '')
                      }
                    }}
                  >
                    <option value="">— someone new —</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                        {c.active > 0 ? ` · ${c.active} active` : ''}
                      </option>
                    ))}
                  </select>
                )}
                {inHouse ? (
                  <div className="guide" style={{ marginTop: 0 }}>
                    <div className="guide-g">
                      <div className="guide-h"><span className="guide-tag">In-house</span></div>
                      <div className="guide-note">
                        Nobody is paying for this one. There is no quote and no invoice — log the
                        runs and hours against it as you go, and Guma counts what your own work
                        costs you and what share of your week is actually billable.
                      </div>
                    </div>
                  </div>
                ) : (
                  <input
                    id="q-client"
                    value={client}
                    onChange={(e) => setClient(e.target.value)}
                    placeholder="Who is paying"
                  />
                )}
                <ClientFieldHint
                  typed={inHouse ? '' : client}
                  clients={clients}
                  onPick={(c) => {
                    setClient(c.name)
                    setContact(c.contact ?? '')
                    setEmail(c.email ?? '')
                    setPhone(c.phone ?? '')
                  }}
                />
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
                Project title *
              </label>
              <input
                id="q-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Four sensor mast brackets"
              />
            </div>
            {inHouse && (
              <div className="fld" style={{ marginTop: 10 }}>
                <label className="lbl" htmlFor="q-within">
                  Piece of a series
                </label>
                <select id="q-within" value={within} onChange={(e) => setWithin(e.target.value)}>
                  <option value="">None — it stands on its own</option>
                  {seriesList
                    .map((x) => ({ id: x.id, label: seriesPath(seriesList, x.id) ?? x.name }))
                    .sort((a, b) => a.label.localeCompare(b.label))
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                </select>
                <div className="hint">
                  For a piece of something bigger — Maui inside BathyTopo › Hawaiian Islands. It
                  moves through its own stages and keeps its own costs; the series adds them up.
                </div>
              </div>
            )}
            <div className="fld" style={{ marginTop: 10 }}>
              <label className="lbl" htmlFor="q-brief">
                What they asked for
              </label>
              <textarea id="q-brief" rows={2} value={brief} onChange={(e) => setBrief(e.target.value)} />
              <div className="hint">
                Two lines you can re-read in three weeks. It is also the first thing the project's
                intake gate checks for.
              </div>
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
  <label
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                cursor: 'pointer',
                marginTop: 12,
                paddingTop: 12,
                borderTop: '1px solid var(--line)',
              }}
            >
              <input
                type="checkbox"
                checked={input.rush}
                onChange={(e) => set('rush')(e.target.checked)}
                style={{ marginTop: 2, width: 'auto' }}
              />
              <span>
                <span style={{ fontSize: 13, color: 'var(--txt)', display: 'block' }}>
                  Rush project — {trimPct(rates.rushPct, rates.locale)}% surcharge
                </span>
                <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                  Jumps the queue and takes a machine off whatever it is on.
                </span>
              </span>
            </label>
          </div>
          {/* Everything that FINE-TUNES a price rather than producing one.
              Collapsed by default: a shop quoting a repeat job should never
              have to scroll past six fields it is not going to change. */}
          <details className="snap" style={{ marginTop: 0 }}>
            <summary
              style={{
                cursor: 'pointer',
                padding: '10px 14px',
                fontSize: 12,
                color: 'var(--txt-2)',
                listStyle: 'none',
              }}
            >
              More options — contact details, billing style, discounts
            </summary>
            <div style={{ padding: '0 14px 14px' }}>
              <div className="grid2" style={{ marginTop: 10 }}>
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
                <div className="fld">
                  <label className="lbl" htmlFor="q-email">
                    Email
                  </label>
                  <input id="q-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              </div>
              <div className="grid2" style={{ marginTop: 10 }}>
                <div className="fld">
                  <label className="lbl" htmlFor="q-phone">
                    Phone
                  </label>
                  <input id="q-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
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
              </div>

                {q.needsDesign && (
                  <div style={{ marginTop: 14 }}>
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
                      <label className="lbl" htmlFor="q-rev">
                        Revision rounds included
                      </label>
                      <input id="q-rev" type="number" min="0" value={input.revisions} onChange={num('revisions')} />
                      <div className="hint">Beyond this, revisions bill hourly at the design rate.</div>
                    </div>
                    </div>
                  </div>
                )}

                <div className="grid2" style={{ marginTop: 14 }}>
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
          </details>
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
                  {trimPct(rates.depositPct, rates.locale)}%{' '}
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
                  ? 'Modeling begins once it clears. The turnaround estimate counts from that day, not from today.'
                  : 'Collected before the project is scheduled onto a machine.'}{' '}
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
          <CostPanel q={q} money={money} qty={input.quantity || 1} />

          <div className="pane" style={{ margin: 0 }}>
            <h3>Rates used</h3>
            <div className="kv" style={{ gridTemplateColumns: '1fr auto', gap: '5px 12px' }}>
              {[
                ['Design and modeling', `${money0(rates.designHourly)} / h`],
                ['Finishing labor', `${money0(rates.finishingHourly)} / h`],
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
                    : `${trimPct(rates.depositPct, rates.locale)}% before ${rates.depositWhen}`,
                ],
                ['Rush surcharge', `${trimPct(rates.rushPct, rates.locale)}%`],
                ['Shop minimum', money0(rates.minimumOrder)],
                [rates.taxLabel, `${trimPct(rates.taxPct, rates.locale)}%`],
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

/**
 * What this print actually costs the shop.
 *
 * The panel this replaces showed four lines, and one of them was wrong: it
 * listed the machine's HOURLY RATE as a cost. That rate is a price the shop
 * chose, not money it spends, so every shop that had filled in its
 * electricity rate was being shown a cost higher than the truth and a
 * margin lower than the truth — the one direction of error that makes a
 * shop turn down work it should take.
 *
 * What a print costs is well established and it is six things, not four:
 * the material, the power, a reserve against machine wear, a share of the
 * overhead that is paid whether or not the machine runs, an allowance for
 * the plates that fail, and the shop's own hours. Guma counted four of them
 * and silently treated the other two as zero.
 *
 * Two rules hold this panel together:
 *
 *   Nothing unmeasured is shown as zero. A line Guma cannot compute is
 *   named, with the field that would fix it, and the total says it is
 *   incomplete. A cost total presented as complete when two of its lines
 *   are quietly missing reads as a margin the shop does not have.
 *
 *   Break-even is stated outright. "What is the lowest I could charge for
 *   this" is the question behind every discount conversation, and a shop
 *   should never have to work it out in its head while a client is waiting.
 */
function CostPanel({
  q,
  money,
  qty,
}: {
  q: PricedQuote
  money: (n: number) => string
  qty: number
}) {
  const rows: [string, string, string?][] = [
    ['Material, at what you paid', money(q.materialCost)],
    ...(q.electricityCost > 0
      ? ([['Power for the machines', money(q.electricityCost)]] as [string, string][])
      : []),
    ['Machine wear reserve', money(q.wearAmt)],
    ...(q.overheadCost > 0
      ? ([
          [
            'Overhead for those hours',
            money(q.overheadCost),
            'Rent, software, insurance and the rest, shared across the machine-hours you actually bill.',
          ],
        ] as [string, string, string][])
      : []),
    ...(q.failureCost > 0
      ? ([
          [
            'Allowance for failed plates',
            money(q.failureCost),
            'A failed plate burns its material and its hours twice and earns once. This is what you expect that to cost on a job this size.',
          ],
        ] as [string, string, string][])
      : []),
    [
      'Your own hours',
      money(q.yourHours),
      'Design and finishing, counted at the rate you charge for them — so margin is what is left AFTER paying yourself.',
    ],
  ]

  const thin = q.margin < 0 ? 'var(--red)' : q.marginPctOfTotal < 0.15 ? 'var(--warn)' : 'var(--ok)'

  return (
    <div className="pane" style={{ margin: 0 }}>
      <h3>
        What this print costs you
        {q.missingCosts.length > 0 && (
          <span style={{ color: 'var(--warn)', fontSize: 10, marginLeft: 8, letterSpacing: 0 }}>
            incomplete
          </span>
        )}
      </h3>

      <div className="kv" style={{ gridTemplateColumns: '1fr auto', gap: '6px 12px' }}>
        {rows.map(([k, v, why]) => (
          <span key={k} style={{ display: 'contents' }}>
            <span className="k" title={why}>
              {k}
            </span>
            <span className="v" style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>
              {v}
            </span>
          </span>
        ))}

        <span
          className="k"
          style={{ color: 'var(--txt)', fontWeight: 600, borderTop: '1px solid var(--line)', paddingTop: 7 }}
        >
          Total cost
        </span>
        <span
          className="v"
          style={{
            fontFamily: 'var(--mono)',
            textAlign: 'right',
            fontWeight: 600,
            borderTop: '1px solid var(--line)',
            paddingTop: 7,
          }}
        >
          {money(q.totalCost)}
        </span>

        {qty > 1 && (
          <>
            <span className="k" style={{ color: 'var(--txt-3)' }}>
              Per piece
            </span>
            <span
              className="v"
              style={{ fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--txt-3)' }}
            >
              {money(q.costPerUnit)}
            </span>
          </>
        )}

        <span className="k" style={{ color: 'var(--txt-3)' }} title="Charge less than this and you are paying to do the work.">
          Break even at
        </span>
        <span
          className="v"
          style={{ fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--txt-3)' }}
        >
          {money(q.breakEven)}
        </span>

        <span className="k" style={{ color: 'var(--txt-2)', fontWeight: 600 }}>
          You keep
        </span>
        <span
          className="v"
          style={{ fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 600, color: thin }}
        >
          {money(q.margin)}
          <span style={{ fontSize: 10, color: 'var(--txt-3)', marginLeft: 6 }}>
            {q.total > 0 ? `${Math.round(q.marginPctOfTotal * 100)}%` : ''}
          </span>
        </span>
      </div>

      {q.missingCosts.length > 0 ? (
        <div className="notice" style={{ marginTop: 10 }}>
          <span>
            <b>Some of your costs are not on file, so this total is lower than the truth.</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
              {q.missingCosts.map((m) => (
                <li key={m.key}>
                  <b>{m.label}</b> — {m.fix}
                </li>
              ))}
            </ul>
          </span>
        </div>
      ) : (
        <div className="hint">
          Every line above is measured rather than assumed: the material from what you actually paid
          for it, the power from this machine's draw and your own tariff, overhead and failures from
          the figures you set. This is the real number.
        </div>
      )}
    </div>
  )
}


/**
 * What this field is about to do.
 *
 * Typing a client name here either joins an existing ledger or opens a new
 * one, and which of the two it is decides where every number about that
 * client lands for the rest of their life with the shop. The field used to
 * decide by exact string equality and then say so confidently, which made
 * it wrong in the exact case that matters: type "hafen gmbh" for a client
 * saved as "Hafen GmbH" and it announced a new client. (It was not one —
 * the save matches case-insensitively — so the label was a lie in the
 * reassuring direction.)
 *
 * Worse is the near miss. "Hafen Gmbh", "Hafen GmbH." and "Hafen" are three
 * clients as far as the database is concerned, each holding a third of the
 * money, and nothing anywhere would ever have said so. So a name that looks
 * like one already on file stops and asks, with a button that takes the
 * existing spelling, before the second ledger exists rather than after.
 */
function ClientFieldHint({
  typed,
  clients,
  onPick,
}: {
  typed: string
  clients: ClientRow[]
  onPick: (client: ClientRow) => void
}) {
  const name = typed.trim()
  // The same rule the save uses (`name like ?`, which is case-insensitive
  // in SQLite), plus accent folding, so the hint cannot promise something
  // different from what happens.
  const exact = clients.find((c) => normalise(c.name) === normalise(name))
  const near = exact || name.length < 2 ? [] : search(clients.map((c) => clientItem(c)), name, { limit: 3 })

  if (exact) {
    return (
      <div className="hint">
        Joins {exact.name}&rsquo;s existing ledger
        {exact.name !== name ? ' — saved under that spelling' : ''}.
        {exact.active > 0 ? ` They have ${exact.active} active project${exact.active === 1 ? '' : 's'}.` : ''}
      </div>
    )
  }

  if (near.length > 0) {
    return (
      <div
        style={{
          marginTop: 6,
          fontSize: 12,
          padding: '8px 10px',
          borderRadius: 'var(--radius)',
          border: '1px solid color-mix(in srgb, var(--warn) 45%, transparent)',
          background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
          color: 'var(--txt-2)',
        }}
      >
        <div style={{ color: 'var(--warn)', marginBottom: 6 }}>
          This will create a second client. Did you mean one you already have?
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {near.map((hit) => {
            const match = clients.find((c) => c.id === hit.id)
            if (!match) return null
            return (
              <button
                key={hit.id}
                type="button"
                className="btn sm"
                onClick={() => onPick(match)}
              >
                Use {match.name}
              </button>
            )
          })}
        </div>
        <div style={{ marginTop: 6, color: 'var(--txt-3)' }}>
          Or carry on — “{name}” will be added as a new client when you save.
        </div>
      </div>
    )
  }

  return (
    <div className="hint">
      {name
        ? 'A new client — they will appear on the Clients screen once this is saved.'
        : clients.length > 0
          ? 'Pick a client above, or type a new name.'
          : 'Your first client. Typing a name here creates them.'}
    </div>
  )
}

/**
 * What the accepted price allows, and what this revision does to it.
 *
 * Three states, and the difference between them is the whole feature:
 *   - inside the ceiling: say so, ask for nothing.
 *   - above it: say by how much, and require the reason the CLIENT caused
 *     it before the save will go through.
 *   - below the accepted price: also worth saying, because a revision that
 *     came down is a thing to tell the client rather than to bury.
 *
 * The reasons are client-caused on purpose. A shop that under-quoted its
 * own print time made a mistake, and billing the client for it is how a
 * shop loses the client; recording it honestly is what makes the same
 * mistake visible the third time it happens.
 */
function RevisionCeiling({
  acceptedTotal,
  total,
  money,
  cause,
  setCause,
  why,
  setWhy,
}: {
  acceptedTotal: number
  total: number
  money: (n: number) => string
  cause: ChangeCause
  setCause: (c: ChangeCause) => void
  why: string
  setWhy: (s: string) => void
}) {
  const { ceiling, over, overPct } = ceilingCheck(acceptedTotal, total)
  return (
    <div className={`attn ${over ? 'crit' : ''}`.trim()} style={{ marginBottom: 12 }}>
      <b>
        {over
          ? `${overPct}% above the price they accepted`
          : total < acceptedTotal
            ? `${money(acceptedTotal - total)} below the price they accepted`
            : 'Inside the accepted price'}
      </b>
      <div style={{ marginTop: 4, fontSize: 12 }}>
        They accepted {money(acceptedTotal)}. Up to {CEILING_PCT}% more — {money(ceiling ?? 0)} —
        needs no explanation. This revision is {money(total)}.
      </div>
      {over && (
        <>
          <div className="fld" style={{ marginTop: 8 }}>
            <label className="lbl" htmlFor="rev-cause">
              What the client changed
            </label>
            <select
              id="rev-cause"
              value={cause}
              onChange={(e) => setCause(e.target.value as ChangeCause)}
            >
              {CHANGE_CAUSES.map((c) => (
                <option key={c} value={c}>
                  {CHANGE_CAUSE_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label className="lbl" htmlFor="rev-why">
              In your words — this goes on the project, and it is what you will read back in six
              months
            </label>
            <input
              id="rev-why"
              value={why}
              placeholder="Added two more brackets and moved the date in a week"
              onChange={(e) => setWhy(e.target.value)}
            />
          </div>
          <div className="hint" style={{ marginTop: 0 }}>
            Guma will save it either way — but not silently. An unexplained rise above a price the
            client agreed to is indistinguishable from a billing error six months later.
          </div>
        </>
      )}
    </div>
  )
}
