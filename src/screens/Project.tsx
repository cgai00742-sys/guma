/**
 * One project, end to end. The screen a shop lives on between "we said
 * yes" and "we got paid".
 *
 * Structure is taken from design-package/design/Project Dialog.dc.html —
 * stage rail, flag strip, a gate for the current stage, and one primary
 * action in the footer with its precondition stated in words beside it —
 * with three deliberate departures:
 *
 *  - It is a PAGE, not a modal. A desktop app can deep-link to a project,
 *    keep it open while it looks at something else, and reload into it.
 *    A <dialog> can do none of that, and the design's own reason for a
 *    modal (it sat on top of a board in a browser tab) doesn't apply here.
 *
 *  - No build sheet. The design's parts table is the one section with no
 *    data behind it: Guma has no parts, no per-part QC and no slicer
 *    import, so the table would be forty rows of invention. It comes back
 *    when the data does.
 *
 *  - A MONEY section in its place. That is the layer this whole app is,
 *    and every number in it is derived from the job_money view rather than
 *    stored — deposit owed, balance owed, and whether either of them is
 *    the actual reason this project is stuck.
 *
 * Every gate item and every flag is computed by src/lib/gates.ts from
 * facts the data layer already loaded, so this file holds no rules of its
 * own about what "ready to advance" means.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  JOB_PHASES,
  CLIENT_KIND_LABEL,
  PAYMENT_KINDS,
  PAYMENT_KIND_LABEL,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  PART_STATUSES,
  PART_STATUS_LABEL,
  WORK_KINDS,
  WORK_KIND_LABEL,
  addPart,
  addProjectNote,
  deletePart,
  setPartStatus,
  deletePrintRun,
  deleteWorkEntry,
  loadProjectDetail,
  logWork,
  recordPrintRun,
  setQuoteStatus,
  recordPayment,
  setGateItem,
  updateJobPhase,
  updateProjectFields,
  type PaymentInput,
  type PaymentKind,
  type PaymentMethod,
  type PartRow,
  type PartStatus,
  type PrintRunInput,
  type ProjectDetail,
  type ProjectFieldsInput,
  type QuoteStatus,
  type RunOutcome,
  type WorkKind,
  type JobPhase,
  type JobPriority,
  toRateSet,
  type ShopContext,
} from '../lib/data'
import {
  GATES,
  PHASE_LABEL,
  flagsFor,
  gateStatus,
  phaseIndex,
  type Flag,
  type ResolvedGateItem,
} from '../lib/gates'
import { makeMoney } from '../lib/pricing'
import { buildComparison, type Comparison } from '../lib/actuals'

const DELIVERY_METHODS = [
  'Collected in person',
  'Hand-delivered',
  'Courier',
  'Post',
  'Digital files only',
]

export default function Project({ ctx }: { ctx: ShopContext }) {
  const { jobId = '' } = useParams()
  const navigate = useNavigate()
  // Intake sends ?quote=1 after "Save quote as PDF": the project is the
  // destination, and the printable opens from it once. Landing straight in
  // the print view was a dead end whose only exit went back to the form.
  const [search, setSearch] = useSearchParams()
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  /** Which stage's checklist is on screen. Defaults to the live one; the
   *  stage rail lets you look back at a cleared gate without moving the
   *  project, which is the whole reason earlier gates are kept. */
  const [viewPhase, setViewPhase] = useState<JobPhase | null>(null)

  const rates = useMemo(() => toRateSet(ctx.rateCard, ctx.shop), [ctx.rateCard, ctx.shop])
  const { money } = useMemo(() => makeMoney(rates.currency, rates.locale), [rates])

  const reload = useCallback(async () => {
    try {
      const d = await loadProjectDetail(ctx.shop.id, jobId)
      setDetail(d)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [ctx.shop.id, jobId])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (search.get('quote') !== '1' || !detail?.quote) return
    const next = new URLSearchParams(search)
    next.delete('quote')
    setSearch(next, { replace: true })
    navigate(`/quote/${detail.quote.id}/print`)
  }, [search, setSearch, detail, navigate])

  if (error && !detail) {
    return (
      <div className="wrap" style={{ paddingTop: 20 }}>
        <div className="attn crit">
          <b>Could not open that project.</b>
          <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11 }}>{error}</div>
        </div>
        <Link to="/projects" className="btn" style={{ marginTop: 12, textDecoration: 'none' }}>
          ← All projects
        </Link>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="wrap" style={{ paddingTop: 24, color: 'var(--txt-3)', fontSize: 12 }}>
        Loading…
      </div>
    )
  }

  // The quote is repriced from its OWN frozen snapshot, never from today's
  // rates — the same rule the printable quote follows. Comparing a job to a
  // rate card that has moved since would produce a variance that is really
  // just a price change.
  const comparison = buildComparison(detail, {
    rateCard: ctx.rateCard,
    shop: ctx.shop,
    materials: ctx.materials,
    printers: ctx.printers,
  })

  const shown = viewPhase ?? detail.phase
  const facts = detail.facts
  const flags = flagsFor(facts)
  const gate = gateStatus(shown, detail.gates[shown] ?? {}, facts)
  const liveGate =
    shown === detail.phase ? gate : gateStatus(detail.phase, detail.gates[detail.phase] ?? {}, facts)

  async function patch(fields: ProjectFieldsInput) {
    setBusy(true)
    try {
      await updateProjectFields(ctx.shop.id, jobId, fields)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function toggleGate(item: ResolvedGateItem, checked: boolean) {
    if (item.automatic) return
    // Optimistic: a checkbox that waits for a round trip feels broken.
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            gates: {
              ...prev.gates,
              [shown]: {
                ...(prev.gates[shown] ?? {}),
                [item.key]: { checked, note: item.note },
              },
            },
          }
        : prev,
    )
    try {
      await setGateItem(ctx.shop.id, jobId, ctx.profile.id, shown, item.key, checked, item.note)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await reload()
    }
  }

  async function saveGateNote(item: ResolvedGateItem, text: string) {
    const next = text.trim() || null
    if (next === item.note) return
    try {
      await setGateItem(ctx.shop.id, jobId, ctx.profile.id, shown, item.key, item.checked, next)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function advance() {
    if (!liveGate.next || liveGate.blocked) return
    setBusy(true)
    try {
      await updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, liveGate.next)
      setViewPhase(null)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function markQuote(status: QuoteStatus) {
    if (!detail?.quote) return
    setBusy(true)
    try {
      await setQuoteStatus(ctx.shop.id, detail.quote.id, ctx.profile.id, status)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function pay(input: PaymentInput) {
    setBusy(true)
    try {
      await recordPayment(ctx.shop.id, jobId, ctx.profile.id, input)
      await reload()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setBusy(false)
    }
  }

  async function postNote() {
    const text = note.trim()
    if (!text) return
    setBusy(true)
    try {
      await addProjectNote(jobId, ctx.profile.id, text)
      setNote('')
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const here = phaseIndex(detail.phase)

  return (
    <div className="wrap" style={{ paddingTop: 16, paddingBottom: 96 }}>
      <div style={{ marginBottom: 10 }}>
        <Link to="/projects" className="linkbtn" style={{ fontSize: 12 }}>
          ← Projects
        </Link>
      </div>

      {/* ---- head: who, what, where in the process, what's wrong ---- */}
      <div className="dlg-title" style={{ alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 18 }}>{detail.title}</h3>
        <span className="pmeta">
          {detail.ref} · {detail.client.name} · {CLIENT_KIND_LABEL[detail.client.kind]}
          {detail.facts.poc ? ` · ${detail.facts.poc}` : ''}
          {detail.facts.neededBy ? ` · due ${detail.facts.neededBy}` : ' · no due date'}
        </span>
      </div>

      <div className="stepper" style={{ marginTop: 12 }}>
        {JOB_PHASES.map((p, i) => (
          <button
            key={p}
            type="button"
            className={`step ${i < here ? 'done' : ''} ${p === shown ? 'cur' : ''}`.trim()}
            style={{ cursor: 'pointer', font: 'inherit' }}
            onClick={() => setViewPhase(p === detail.phase ? null : p)}
            title={
              i < here
                ? `${PHASE_LABEL[p]} — cleared. Click to review its gate.`
                : i === here
                  ? `${PHASE_LABEL[p]} — where this project is now.`
                  : `${PHASE_LABEL[p]} — not reached yet. Click to see what it will ask for.`
            }
          >
            <i />
            {PHASE_LABEL[p]}
          </button>
        ))}
      </div>

      {flags.length > 0 && (
        <div className="dlg-flags" style={{ marginTop: 10 }}>
          {flags.map((f) => (
            <span key={f.key} className={`flagtag ${f.tone}`}>
              {f.label}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="attn crit" style={{ marginTop: 12 }}>
          <span>{error}</span>
        </div>
      )}

      {/* ---- flags, spelled out ---- */}
      {flags.length > 0 && <FlagPanel flags={flags} />}

      {/* ---- what this project is ----
          Sits first because the intake gate reads the brief, and a fact a
          gate reads has to be changeable from the same screen that tells
          you it is blocking. It was not, and a project saved with an empty
          brief could never leave intake. */}
      <section className="sec" style={{ marginTop: 18 }}>
        <div className="sechead">
          <h4>The brief</h4>
          <span className={`secstat ${(detail.brief ?? '').trim().length >= 20 ? 'ok' : 'warn'}`}>
            {(detail.brief ?? '').trim() ? 'written down' : 'nothing written down'}
          </span>
        </div>
        <div className="pane" style={{ marginBottom: 0 }}>
          <div className="fld">
            <label className="lbl" htmlFor="p-title">
              Project
            </label>
            <input
              id="p-title"
              defaultValue={detail.title}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== detail.title) void patch({ title: v })
              }}
            />
          </div>
          <div className="fld" style={{ marginBottom: 0 }}>
            <label className="lbl" htmlFor="p-brief">
              What they asked for
            </label>
            <textarea
              id="p-brief"
              rows={3}
              defaultValue={detail.brief ?? ''}
              placeholder="Two lines you can re-read in three weeks."
              onBlur={(e) => {
                const v = e.target.value.trim() || null
                if (v !== detail.brief) void patch({ brief: v })
              }}
            />
            <div className="hint">
              Saved when you click away. The intake gate reads this, so it is worth the two lines —
              and it is the thing you will wish you had written when the revision argument starts.
            </div>
          </div>
        </div>
      </section>

      {/* ---- the gate ---- */}
      <section className="sec" style={{ marginTop: 18 }}>
        <div className="sechead">
          <h4>
            {PHASE_LABEL[shown]}
            {gate.next ? ` — gate to ${PHASE_LABEL[gate.next]}` : ''}
          </h4>
          <span className={`secstat ${gate.total === 0 ? '' : gate.blocked ? 'warn' : 'ok'}`}>
            {gate.total === 0 ? 'no gate' : `${gate.done} of ${gate.total} cleared`}
          </span>
        </div>

        {shown !== detail.phase && (
          <div className="hint" style={{ marginBottom: 6 }}>
            Looking at {PHASE_LABEL[shown]}, which is{' '}
            {phaseIndex(shown) < here ? 'already behind you' : 'still ahead'}. Ticking here still
            records a real answer —{' '}
            <button type="button" className="linkbtn" onClick={() => setViewPhase(null)}>
              back to {PHASE_LABEL[detail.phase]}
            </button>
            .
          </div>
        )}

        {gate.total === 0 ? (
          <div className="gatebox">
            <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
              Delivered is the end of the line — there is nothing left to check off. What matters
              now is whether the balance came in, which is in Money below.
            </div>
          </div>
        ) : (
          <div className="gatebox">
            <div className="ggroup">Required before advancing</div>
            {gate.items.map((item) => (
              <GateRow
                key={item.key}
                item={item}
                onToggle={(c) => void toggleGate(item, c)}
                onNote={(t) => void saveGateNote(item, t)}
              />
            ))}
            {gate.blocked && <div className="gblock">{gate.reason}</div>}
          </div>
        )}
      </section>

      {/* ---- money ---- */}
      <section className="sec">
        <div className="sechead">
          <h4>Money</h4>
          <span
            className={`secstat ${
              facts.depositOwed > 0 || (detail.phase === 'delivered' && facts.balanceOwed > 0)
                ? 'crit'
                : facts.quoteStatus === null
                  ? 'warn'
                  : 'ok'
            }`}
          >
            {facts.quoteStatus === null ? 'not priced' : `quote ${facts.quoteStatus}`}
          </span>
        </div>
        <div className="pane" style={{ marginBottom: 0 }}>
          {facts.quoteStatus === null ? (
            <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
              No quote has been priced for this project yet. Everything spent on it so far is
              unbilled.{' '}
              <Link to="/intake" className="linkbtn">
                Price it now
              </Link>
              .
            </div>
          ) : (
            <>
              <div className="grid3">
                <Stat label="Quoted" value={facts.quoteTotal == null ? '—' : money(facts.quoteTotal)} />
                <Stat
                  label="Deposit owed"
                  value={money(facts.depositOwed)}
                  tone={facts.depositOwed > 0 ? 'crit' : 'ok'}
                  sub={facts.depositDue > 0 ? `of ${money(facts.depositDue)} due` : 'none required'}
                />
                <Stat
                  label="Balance owed"
                  value={money(facts.balanceOwed)}
                  tone={
                    facts.balanceOwed > 0 && detail.phase === 'delivered'
                      ? 'crit'
                      : facts.balanceOwed > 0
                        ? ''
                        : 'ok'
                  }
                  sub={facts.balanceOwed > 0 ? 'still outstanding' : 'paid in full'}
                />
              </div>
              <div className="btnrow" style={{ marginTop: 12, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <span style={{ color: 'var(--txt-3)' }}>Quote is</span>
                  <select
                    value={facts.quoteStatus ?? 'draft'}
                    disabled={busy || !detail.quote}
                    style={{ width: 'auto' }}
                    onChange={(e) => void markQuote(e.target.value as QuoteStatus)}
                  >
                    <option value="draft">a draft — not sent yet</option>
                    <option value="sent">sent to the client</option>
                    <option value="accepted">accepted</option>
                    <option value="declined">declined</option>
                    <option value="expired">expired</option>
                  </select>
                </label>
                <span className="hint" style={{ marginTop: 0 }}>
                  The client-approval gate reads this. Move it when the quote actually moves — a
                  quote marked accepted that nobody agreed to is worse than no record at all.
                </span>
              </div>

              <div className="hint" style={{ marginTop: 10 }}>
                Every figure here is derived from the payments below, not stored — record one and
                all three move at once.
                {detail.quote?.status === 'sent' || detail.quote?.status === 'accepted' ? (
                  <>
                    {' '}
                    <Link to={`/quote/${detail.quote.id}/print`} className="linkbtn">
                      Open the quote document
                    </Link>
                    .
                  </>
                ) : null}
              </div>

              <PaymentLog
                payments={detail.payments}
                money={money}
                suggestion={
                  facts.depositOwed > 0
                    ? { kind: 'deposit', amount: facts.depositOwed }
                    : facts.balanceOwed > 0
                      ? { kind: 'balance', amount: facts.balanceOwed }
                      : null
                }
                quoteId={detail.quote?.id ?? null}
                busy={busy}
                onRecord={pay}
              />
            </>
          )}
        </div>
      </section>

      {/* ---- the promise ---- */}
      <section className="sec">
        <div className="sechead">
          <h4>Who and when</h4>
          <span className={`secstat ${facts.windowLocked ? 'ok' : 'warn'}`}>
            {facts.windowLocked ? 'committed' : 'still moveable'}
          </span>
        </div>
        <div className="pane" style={{ marginBottom: 0 }}>
          <div className="grid3">
            <div className="fld">
              <label className="lbl" htmlFor="w-from">
                Earliest
              </label>
              <input
                id="w-from"
                type="date"
                value={facts.windowFrom ?? ''}
                onChange={(e) => void patch({ windowFrom: e.target.value || null })}
              />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="w-to">
                Needed by
              </label>
              <input
                id="w-to"
                type="date"
                value={facts.neededBy ?? ''}
                onChange={(e) => void patch({ neededBy: e.target.value || null })}
              />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="poc">
                Point of contact
              </label>
              <input
                id="poc"
                defaultValue={facts.poc ?? ''}
                placeholder="Who to chase"
                onBlur={(e) => {
                  if ((e.target.value.trim() || null) !== facts.poc)
                    void patch({ poc: e.target.value.trim() || null })
                }}
              />
            </div>
          </div>
          <div className="btnrow" style={{ alignItems: 'center' }}>
            <button
              type="button"
              className={facts.windowLocked ? 'btn' : 'btn primary'}
              disabled={busy || !facts.neededBy}
              onClick={() => void patch({ windowLocked: !facts.windowLocked })}
            >
              {facts.windowLocked ? 'Reopen the window' : 'Commit to this date'}
            </button>
            <button
              type="button"
              className={facts.atRisk ? 'btn danger' : 'btn'}
              disabled={busy}
              onClick={() => void patch({ atRisk: !facts.atRisk })}
            >
              {facts.atRisk ? 'Clear the risk flag' : 'Flag as at risk'}
            </button>
            <span className="hint" style={{ marginTop: 0 }}>
              {!facts.neededBy
                ? 'Set a date before committing to one.'
                : facts.windowLocked
                  ? 'The client is holding you to this. Reopening it is a conversation you have to have with them.'
                  : 'Until you commit, this date is yours to move without telling anyone.'}
            </span>
          </div>
        </div>
      </section>

      {/* ---- what actually happened ---- */}
      <section className="sec">
        <div className="sechead">
          <h4>Handover</h4>
          <span className={`secstat ${facts.deliveryOn ? 'ok' : ''}`}>
            {facts.deliveryOn ? `handed over ${facts.deliveryOn}` : 'not yet delivered'}
          </span>
        </div>
        <div className="pane" style={{ marginBottom: 0 }}>
          <div className="grid2">
            <div className="fld">
              <label className="lbl" htmlFor="d-on">
                Date it changed hands
              </label>
              <input
                id="d-on"
                type="date"
                value={facts.deliveryOn ?? ''}
                onChange={(e) => void patch({ deliveryOn: e.target.value || null })}
              />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="d-how">
                How
              </label>
              <select
                id="d-how"
                value={facts.deliveryHow ?? ''}
                onChange={(e) => void patch({ deliveryHow: e.target.value || null })}
              >
                <option value="">—</option>
                {DELIVERY_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="hint" style={{ marginTop: 0 }}>
            Recorded because it is the date every later argument is measured from — a warranty
            claim, a late-payment chase, a repeat order six months on.
          </div>
        </div>
      </section>

      {/* ---- the build sheet ---- */}
      <section className="sec">
        <div className="sechead">
          <h4>Build sheet</h4>
          <span
            className={`secstat ${
              detail.parts.length === 0
                ? ''
                : facts.partsReprint > 0
                  ? 'warn'
                  : facts.partsPassed === facts.parts
                    ? 'ok'
                    : ''
            }`}
          >
            {detail.parts.length === 0
              ? 'not used on this project'
              : `${facts.partsPassed} of ${facts.parts} passed` +
                (facts.partsReprint > 0 ? ` · ${facts.partsReprint} going back` : '')}
          </span>
        </div>
        <BuildSheet
          ctx={ctx}
          detail={detail}
          locked={phaseIndex(detail.phase) >= phaseIndex('review')}
          busy={busy}
          onChanged={reload}
          setError={setError}
        />
      </section>

      {/* ---- what it actually took ---- */}
      <section className="sec">
        <div className="sechead">
          <h4>What it actually took</h4>
          <span
            className={`secstat ${
              comparison === null
                ? ''
                : !comparison.hasActuals
                  ? ''
                  : comparison.actualMargin !== null && comparison.actualMargin < 0
                    ? 'crit'
                    : comparison.actualCost !== null && comparison.actualCost > comparison.quotedCost
                      ? 'warn'
                      : 'ok'
            }`}
          >
            {comparison === null
              ? 'needs a quote'
              : !comparison.hasActuals
                ? 'nothing recorded yet'
                : comparison.partial
                  ? 'partly recorded'
                  : `real margin ${money(comparison.actualMargin ?? 0)}`}
          </span>
        </div>
        <div className="pane" style={{ marginBottom: 0 }}>
          {comparison === null ? (
            <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
              There is nothing to compare against until this project has a quote. Runs and hours can
              still be logged below — they will line up once it does.
            </div>
          ) : (
            <Variance comparison={comparison} money={money} />
          )}

          <RunLog
            ctx={ctx}
            detail={detail}
            money={money}
            busy={busy}
            onChanged={reload}
            setError={setError}
          />
        </div>
      </section>

      {/* ---- activity ---- */}
      <section className="sec">
        <div className="sechead">
          <h4>Activity</h4>
          <span className="secstat">
            {detail.events.length} entr{detail.events.length === 1 ? 'y' : 'ies'}
          </span>
        </div>
        <div className="pane" style={{ marginBottom: 0 }}>
          <div className="fld" style={{ marginBottom: 8 }}>
            <textarea
              value={note}
              rows={2}
              placeholder="What changed? Even “waiting on the client” is information the next person needs."
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || !note.trim()}
            onClick={() => void postNote()}
          >
            Post update
          </button>

          <div className="updates">
            {detail.events.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--txt-3)' }}>
                Nothing logged yet. Moving this project between stages will start the record on its
                own.
              </div>
            )}
            {detail.events.map((e) => (
              <div key={e.id} className="upd">
                <div className="m">
                  {e.actorName ?? 'Someone'} · {e.at.slice(0, 10)}
                  {e.kind === 'phase_change' ? ' · stage change' : ''}
                </div>
                {e.kind === 'phase_change'
                  ? `Moved from ${PHASE_LABEL[e.fromPhase ?? 'intake']} to ${PHASE_LABEL[e.toPhase ?? 'intake']}.`
                  : (e.body ?? '')}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- earlier stages ---- */}
      <section className="sec">
        <div className="sechead">
          <h4>Earlier stages</h4>
          <span className="secstat">{here === 0 ? 'none yet' : `${here} behind this one`}</span>
        </div>
        <div className="stack">
          {JOB_PHASES.slice(0, here).map((p) => {
            const g = gateStatus(p, detail.gates[p] ?? {}, facts)
            return (
              <details key={p}>
                <summary>
                  <span className="caret">▸</span>
                  <b>{PHASE_LABEL[p]}</b>
                  <span className={`secstat ${g.blocked ? 'warn' : 'ok'}`}>
                    {g.done} of {g.total}
                  </span>
                </summary>
                <div className="dbody">
                  {g.items.map((i) => (
                    <div key={i.key} className="histitem">
                      <span style={{ color: i.checked ? 'var(--ok)' : 'var(--warn)' }}>
                        {i.checked ? '✓' : '·'}
                      </span>
                      <span>{i.label}</span>
                      {i.note && <div className="histnote">{i.note}</div>}
                    </div>
                  ))}
                  {g.blocked && (
                    <div className="hint">
                      This stage was advanced past with items outstanding. That is allowed — the
                      record just says so.
                    </div>
                  )}
                </div>
              </details>
            )
          })}
          {here === 0 && (
            <div style={{ fontSize: 12, color: 'var(--txt-3)' }}>
              This project is still in its first stage.
            </div>
          )}
        </div>
      </section>

      {/* ---- one primary action, with its precondition beside it ---- */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          marginTop: 20,
          padding: '10px 0',
          background: 'var(--bg)',
          borderTop: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span className="gatewhy" style={{ fontSize: 11, color: 'var(--txt-3)', maxWidth: '52ch' }}>
          {liveGate.reason}
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <PrioritySelect
          value={detail.priority}
          disabled={busy}
          onChange={(p) => void patch({ priority: p })}
        />
        <Link
          to={`/project/${jobId}/closeout`}
          className="btn"
          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          title="A printable one-pager: what it was quoted at, what it took, what it earned."
        >
          Closeout sheet
        </Link>
        <button
          type="button"
          className="btn"
          onClick={() => navigate('/projects')}
          style={{ textDecoration: 'none' }}
        >
          Back to projects
        </button>
        <button
          type="button"
          className="btn primary advance"
          disabled={busy || liveGate.blocked || liveGate.next === null}
          title={liveGate.blocked ? liveGate.reason : undefined}
          onClick={() => void advance()}
        >
          {liveGate.next ? `Advance to ${PHASE_LABEL[liveGate.next]} →` : 'Delivered'}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Payments in, and the one form that puts them there.
 *
 * The form pre-fills with whatever is actually outstanding — the deposit
 * first, then the balance — because that is what a shop is recording 95%
 * of the time, and a pre-filled amount they correct is faster than an
 * empty box they have to look up. Both fields stay editable: part payments
 * are normal, and so is a client who rounds up.
 */
function PaymentLog({
  payments,
  money,
  suggestion,
  quoteId,
  busy,
  onRecord,
}: {
  payments: ProjectDetail['payments']
  money: (n: number) => string
  suggestion: { kind: PaymentKind; amount: number } | null
  quoteId: string | null
  busy: boolean
  onRecord: (input: PaymentInput) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<PaymentKind>(suggestion?.kind ?? 'balance')
  const [amount, setAmount] = useState(suggestion ? suggestion.amount.toFixed(2) : '')
  const [method, setMethod] = useState<PaymentMethod>('transfer')
  const [when, setWhen] = useState(() => new Date().toISOString().slice(0, 10))
  const [why, setWhy] = useState('')

  const n = Number(amount)
  const valid = Number.isFinite(n) && n > 0

  return (
    <div className="updates" style={{ marginTop: 14 }}>
      {payments.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--txt-3)' }}>
          Nothing received yet against this project.
        </div>
      ) : (
        payments.map((p) => (
          <div key={p.id} className="histitem">
            <span style={{ fontWeight: 500, color: p.kind === 'refund' ? 'var(--red)' : 'var(--ok)' }}>
              {p.kind === 'refund' ? '−' : '+'}
              {money(p.amount)}
            </span>
            <span style={{ color: 'var(--txt-2)' }}>{PAYMENT_KIND_LABEL[p.kind]}</span>
            <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>
              {PAYMENT_METHOD_LABEL[p.method]} · {p.receivedOn}
              {p.recordedBy ? ` · ${p.recordedBy}` : ''}
            </span>
            {p.note && <div className="histnote">{p.note}</div>}
          </div>
        ))
      )}

      {!open ? (
        <button
          type="button"
          className="btn sm"
          style={{ marginTop: 10 }}
          onClick={() => setOpen(true)}
        >
          Record a payment
        </button>
      ) : (
        <div className="gatebox" style={{ marginTop: 10 }}>
          <div className="grid3">
            <div className="fld">
              <label className="lbl" htmlFor="p-kind">
                What kind
              </label>
              <select id="p-kind" value={kind} onChange={(e) => setKind(e.target.value as PaymentKind)}>
                {PAYMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PAYMENT_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="p-amt">
                Amount
              </label>
              <input
                id="p-amt"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="p-when">
                Received on
              </label>
              <input id="p-when" type="date" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
          </div>
          <div className="grid2">
            <div className="fld">
              <label className="lbl" htmlFor="p-how">
                How
              </label>
              <select
                id="p-how"
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="p-note">
                Reference
              </label>
              <input
                id="p-note"
                value={why}
                placeholder="Cheque number, transfer reference…"
                onChange={(e) => setWhy(e.target.value)}
              />
            </div>
          </div>
          <div className="btnrow">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || !valid}
              onClick={() => {
                void onRecord({
                  kind,
                  amount: n,
                  method,
                  receivedOn: when,
                  note: why.trim() || null,
                  quoteId,
                })
                  .then(() => {
                    setOpen(false)
                    setWhy('')
                  })
                  .catch(() => {
                    /* the page shows the error; keep the form open */
                  })
              }}
            >
              Record it
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <span className="hint" style={{ marginTop: 0 }}>
              Payments are never edited or deleted — a mistake is corrected with a refund, which is
              what an accountant will expect to find.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/** Quoted against actual, line by line. */
function Variance({ comparison, money }: { comparison: Comparison; money: (n: number) => string }) {
  const c = comparison
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Cost</th>
              <th className="r">Quoted</th>
              <th className="r">Actual</th>
              <th className="r">Difference</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l) => (
              <tr key={l.key}>
                <td>
                  <div style={{ color: 'var(--txt)' }}>{l.label}</div>
                  <div className="pmeta" style={{ whiteSpace: 'normal' }}>
                    {l.detail}
                  </div>
                </td>
                <td className="r mono">{money(l.quoted)}</td>
                <td className="r mono" style={{ color: l.actual === null ? 'var(--txt-3)' : undefined }}>
                  {l.actual === null ? 'not recorded' : money(l.actual)}
                </td>
                <td
                  className="r mono"
                  style={{
                    color:
                      l.delta === null
                        ? 'var(--txt-3)'
                        : l.delta > 0.005
                          ? 'var(--red)'
                          : l.delta < -0.005
                            ? 'var(--ok)'
                            : 'var(--txt-3)',
                  }}
                >
                  {l.delta === null
                    ? '—'
                    : `${l.delta > 0 ? '+' : ''}${money(l.delta)}${
                        l.pct === null ? '' : ` (${l.pct > 0 ? '+' : ''}${Math.round(l.pct * 100)}%)`
                      }`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid3" style={{ marginTop: 12 }}>
        <Stat label="They pay (before tax)" value={money(c.netRevenue)} />
        <Stat label="Margin you quoted" value={money(c.quotedMargin)} />
        <Stat
          label="Margin you got"
          value={c.actualMargin === null ? 'not yet' : money(c.actualMargin)}
          tone={
            c.actualMargin === null ? '' : c.actualMargin < 0 ? 'crit' : c.actualMargin < c.quotedMargin * 0.5 ? '' : 'ok'
          }
          sub={
            c.actualMarginPct === null
              ? 'log a run or some hours'
              : `${Math.round(c.actualMarginPct * 100)}% of what they pay`
          }
        />
      </div>

      {c.partial && (
        <div className="hint" style={{ marginTop: 8, color: 'var(--warn)' }}>
          Some lines have nothing recorded against them, so the real margin above is a ceiling, not a
          figure — it can only get worse as the rest goes in.
        </div>
      )}
    </>
  )
}

/**
 * The build sheet: what is being made, and where each piece has got to.
 *
 * Ported from Voltage, including the rule that matters most — from Review
 * onwards the sheet LOCKS to QC. You can pass a part or send it back; you
 * cannot add, rename or remove one. Once you are checking work against a
 * list, a list that can still change is not a check, and a shop that can
 * quietly delete the part it broke has no build sheet at all.
 *
 * Guma's own addition is the line at the bottom. Voltage treats a reprint
 * as a status; here it is a cost, because 0006 knows what a build consumed
 * and a part going back means material and machine time spent twice on a
 * project whose margin is already being watched. That is the only reason a
 * money layer wants a build sheet in the first place.
 *
 * A project that never adds a part is not penalised anywhere: the two gate
 * items that read this return null with no parts on file and fall back to
 * a manual tick. A feature nobody opted into must never become a blocker.
 */
function BuildSheet({
  ctx,
  detail,
  locked,
  busy,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  locked: boolean
  busy: boolean
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const [label, setLabel] = useState('')
  const [qty, setQty] = useState('1')
  const [saving, setSaving] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [reprintFor, setReprintFor] = useState<string | null>(null)
  const [why, setWhy] = useState('')

  async function guard(fn: () => Promise<unknown>) {
    setSaving(true)
    setError(null)
    try {
      await fn()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function move(part: PartRow, status: PartStatus) {
    if (status === 'reprint') {
      setReprintFor(part.id)
      setWhy('')
      return
    }
    await guard(() => setPartStatus(ctx.shop.id, part.id, ctx.profile.id, status, null))
  }

  return (
    <div className="pane" style={{ marginBottom: 0 }}>
      {detail.parts.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
          Nothing listed. A build sheet is worth keeping when a project is more than one object —
          it is what turns &ldquo;is it done?&rdquo; into a countable answer, and it is where a part
          that keeps coming back stops looking like bad luck. Projects that do not need one are not
          penalised: the gate items that read this step aside when it is empty.
        </div>
      ) : (
        <div className="sheetwrap" style={{ maxHeight: 'none' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: '46%' }}>Part</th>
                <th className="r">Copies</th>
                <th style={{ width: 190 }}>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.parts.map((p) => (
                <Fragment key={p.id}>
                  <tr>
                    <td>
                      <span className="pn">{p.label}</span>
                      {p.history.length > 1 && (
                        <button
                          type="button"
                          className="linkbtn"
                          style={{ marginLeft: 8, fontSize: 10 }}
                          onClick={() => setOpenId(openId === p.id ? null : p.id)}
                        >
                          history ({p.history.length})
                        </button>
                      )}
                      {p.note && <div className="pmeta">{p.note}</div>}
                    </td>
                    <td className="r mono">×{p.qty}</td>
                    <td>
                      {/* Same fixed two-slot grammar as the board card and
                          the design package: square = printed, disc = QC. */}
                      <span className="pstat" aria-hidden="true">
                        <i
                          className={`s-print ${p.status === 'pending' ? '' : 'on'}`.trim()}
                        />
                        <i
                          className={`s-qc ${
                            p.status === 'passed' ? 'on' : p.status === 'reprint' ? 'on fail' : ''
                          }`.trim()}
                        />
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color:
                            p.status === 'reprint'
                              ? 'var(--red)'
                              : p.status === 'passed'
                                ? 'var(--ok)'
                                : p.status === 'printed'
                                  ? 'var(--warn)'
                                  : 'var(--txt-3)',
                        }}
                      >
                        {PART_STATUS_LABEL[p.status]}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        {PART_STATUSES.filter((st) => st !== p.status && st !== 'pending').map(
                          (st) => (
                            <button
                              key={st}
                              type="button"
                              className="btn sm ghost"
                              disabled={busy || saving}
                              style={{ fontSize: 10 }}
                              onClick={() => void move(p, st)}
                            >
                              {st === 'printed' ? 'Printed' : st === 'passed' ? 'Pass' : 'Send back'}
                            </button>
                          ),
                        )}
                        {!locked && (
                          <button
                            type="button"
                            className="linkbtn"
                            style={{ fontSize: 10 }}
                            disabled={busy || saving}
                            onClick={() => void guard(() => deletePart(ctx.shop.id, p.id))}
                          >
                            remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {reprintFor === p.id && (
                    <tr>
                      <td colSpan={4} style={{ background: 'var(--panel-3)' }}>
                        <div className="fld" style={{ margin: 0 }}>
                          <label className="lbl" htmlFor={`why-${p.id}`}>
                            What went wrong
                          </label>
                          <input
                            id={`why-${p.id}`}
                            value={why}
                            autoFocus
                            placeholder="Layer shift at 40mm, warped corner, wrong colour…"
                            onChange={(e) => setWhy(e.target.value)}
                          />
                        </div>
                        <div className="btnrow" style={{ marginTop: 6, alignItems: 'center' }}>
                          <button
                            type="button"
                            className="btn sm primary"
                            disabled={!why.trim() || saving}
                            onClick={() =>
                              void guard(async () => {
                                await setPartStatus(
                                  ctx.shop.id,
                                  p.id,
                                  ctx.profile.id,
                                  'reprint',
                                  why,
                                )
                                setReprintFor(null)
                              })
                            }
                          >
                            Send it back
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost"
                            onClick={() => setReprintFor(null)}
                          >
                            Cancel
                          </button>
                          <span className="hint" style={{ marginTop: 0 }}>
                            A reason is required here and nowhere else. &ldquo;Passed&rdquo; explains
                            itself; a reprint never does, and the same reason twice is a design
                            problem rather than bad luck.
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {openId === p.id && (
                    <tr>
                      <td colSpan={4} style={{ background: 'var(--panel-2)' }}>
                        {p.history.map((h) => (
                          <div key={h.id} className="histitem">
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--txt-3)' }}>
                              {h.at.slice(0, 10)}
                            </span>
                            <span style={{ color: 'var(--txt-2)' }}>
                              {h.fromStatus
                                ? `${PART_STATUS_LABEL[h.fromStatus]} → ${PART_STATUS_LABEL[h.toStatus ?? 'pending']}`
                                : PART_STATUS_LABEL[h.toStatus ?? 'pending']}
                            </span>
                            {h.actor && (
                              <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>{h.actor}</span>
                            )}
                            {h.note && <div className="histnote">{h.note}</div>}
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail.parts.length > 0 && (
        <div className="sheetsum">
          <span>Square = printed · disc = passed QC · red = going back</span>
          <span style={{ marginLeft: 'auto' }}>
            {detail.facts.parts} part{detail.facts.parts === 1 ? '' : 's'} ·{' '}
            {detail.parts.reduce((n, p) => n + p.qty, 0)} copies
            {detail.facts.reprintsEver > 0 && (
              <span style={{ color: 'var(--warn)' }}>
                {' '}
                · sent back {detail.facts.reprintsEver} time
                {detail.facts.reprintsEver === 1 ? '' : 's'} so far
              </span>
            )}
          </span>
        </div>
      )}

      {locked ? (
        <div className="hint" style={{ marginTop: 10 }}>
          The sheet is locked from Review onwards — pass a part or send it back, but the list itself
          no longer moves. Checking work against a list that can still change is not checking.
        </div>
      ) : (
        <div className="btnrow" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <div className="fld" style={{ margin: 0, flex: 1, minWidth: 180 }}>
            <label className="lbl" htmlFor="part-label">
              Part
            </label>
            <input
              id="part-label"
              value={label}
              placeholder="Mast bracket, left"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="fld" style={{ margin: 0, width: 90 }}>
            <label className="lbl" htmlFor="part-qty">
              Copies
            </label>
            <input
              id="part-qty"
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || saving || !label.trim()}
            onClick={() =>
              void guard(async () => {
                await addPart(ctx.shop.id, detail.jobId, ctx.profile.id, {
                  label,
                  qty: Number(qty) || 1,
                })
                setLabel('')
                setQty('1')
              })
            }
          >
            Add
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The two things a shop has to type in for any of the above to mean
 * anything: a build run, and an hour of work.
 *
 * Kept together and kept short. Every field here is one a person can answer
 * from memory at the end of a day — which machine, roughly how long, how
 * many grams off the spool, did it work. Anything that needed a stopwatch
 * or a lookup would not get filled in, and a log nobody fills in is worse
 * than no log at all, because it looks like evidence.
 */
function RunLog({
  ctx,
  detail,
  money,
  busy,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  money: (n: number) => string
  busy: boolean
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const [mode, setMode] = useState<'none' | 'run' | 'work'>('none')
  const [saving, setSaving] = useState(false)

  const [run, setRun] = useState<PrintRunInput>({
    printerId: ctx.printers[0]?.id ?? '',
    materialId: ctx.materials[0]?.id ?? null,
    unitsUsed: 0,
    hours: 0,
    outcome: 'success',
    failureReason: null,
    note: null,
    startedAt: new Date().toISOString().slice(0, 10),
  })
  const [work, setWork] = useState({
    kind: 'design' as WorkKind,
    hours: '',
    workedOn: new Date().toISOString().slice(0, 10),
    note: '',
  })

  const unit = ctx.materials.find((m) => m.id === run.materialId)?.unit ?? 'g'

  async function guard(fn: () => Promise<unknown>) {
    setSaving(true)
    setError(null)
    try {
      await fn()
      await onChanged()
      setMode('none')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="updates" style={{ marginTop: 14 }}>
      {mode === 'none' && (
        <div className="btnrow">
          <button type="button" className="btn sm" disabled={busy} onClick={() => setMode('run')}>
            Record a build run
          </button>
          <button type="button" className="btn sm" disabled={busy} onClick={() => setMode('work')}>
            Log hours
          </button>
        </div>
      )}

      {mode === 'run' && (
        <div className="gatebox">
          <div className="grid3">
            <div className="fld">
              <label className="lbl" htmlFor="r-printer">
                Machine
              </label>
              <select
                id="r-printer"
                value={run.printerId}
                onChange={(e) => setRun((r) => ({ ...r, printerId: e.target.value }))}
              >
                {ctx.printers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="r-material">
                Material
              </label>
              <select
                id="r-material"
                value={run.materialId ?? ''}
                onChange={(e) => setRun((r) => ({ ...r, materialId: e.target.value || null }))}
              >
                {ctx.materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="r-when">
                Started
              </label>
              <input
                id="r-when"
                type="date"
                value={run.startedAt ?? ''}
                onChange={(e) => setRun((r) => ({ ...r, startedAt: e.target.value || null }))}
              />
            </div>
          </div>
          <div className="grid3">
            <div className="fld">
              <label className="lbl" htmlFor="r-units">
                {unit} off the spool
              </label>
              <input
                id="r-units"
                type="number"
                min="0"
                step="1"
                value={run.unitsUsed || ''}
                onChange={(e) => setRun((r) => ({ ...r, unitsUsed: Number(e.target.value) || 0 }))}
              />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="r-hours">
                Machine hours
              </label>
              <input
                id="r-hours"
                type="number"
                min="0"
                step="0.25"
                value={run.hours || ''}
                onChange={(e) => setRun((r) => ({ ...r, hours: Number(e.target.value) || 0 }))}
              />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="r-outcome">
                How it went
              </label>
              <select
                id="r-outcome"
                value={run.outcome}
                onChange={(e) => setRun((r) => ({ ...r, outcome: e.target.value as RunOutcome }))}
              >
                <option value="success">Came off clean</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled part way</option>
              </select>
            </div>
          </div>
          {run.outcome !== 'success' && (
            <div className="fld">
              <label className="lbl" htmlFor="r-why">
                What went wrong
              </label>
              <input
                id="r-why"
                value={run.failureReason ?? ''}
                placeholder="Warped off the plate, clog, power cut…"
                onChange={(e) => setRun((r) => ({ ...r, failureReason: e.target.value || null }))}
              />
            </div>
          )}
          <div className="btnrow" style={{ alignItems: 'center' }}>
            <button
              type="button"
              className="btn sm primary"
              disabled={saving || !run.printerId}
              onClick={() =>
                void guard(() => recordPrintRun(ctx.shop.id, detail.jobId, ctx.profile.id, run))
              }
            >
              Record it
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setMode('none')}>
              Cancel
            </button>
            <span className="hint" style={{ marginTop: 0 }}>
              A failed run counts too — it burned the same material and the same machine hours, and a
              shop that leaves failures out thinks its margin is better than it is.
            </span>
          </div>
        </div>
      )}

      {mode === 'work' && (
        <div className="gatebox">
          <div className="grid3">
            <div className="fld">
              <label className="lbl" htmlFor="w-kind">
                What kind of work
              </label>
              <select
                id="w-kind"
                value={work.kind}
                onChange={(e) => setWork((w) => ({ ...w, kind: e.target.value as WorkKind }))}
              >
                {WORK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {WORK_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="w-hours">
                Hours
              </label>
              <input
                id="w-hours"
                type="number"
                min="0"
                step="0.25"
                value={work.hours}
                onChange={(e) => setWork((w) => ({ ...w, hours: e.target.value }))}
              />
            </div>
            <div className="fld">
              <label className="lbl" htmlFor="w-when">
                On
              </label>
              <input
                id="w-when"
                type="date"
                value={work.workedOn}
                onChange={(e) => setWork((w) => ({ ...w, workedOn: e.target.value }))}
              />
            </div>
          </div>
          <div className="fld">
            <label className="lbl" htmlFor="w-note">
              What you did
            </label>
            <input
              id="w-note"
              value={work.note}
              placeholder="Modelled the mount, third revision, wash and cure…"
              onChange={(e) => setWork((w) => ({ ...w, note: e.target.value }))}
            />
          </div>
          <div className="btnrow" style={{ alignItems: 'center' }}>
            <button
              type="button"
              className="btn sm primary"
              disabled={saving || !work.hours}
              onClick={() =>
                void guard(() =>
                  logWork(ctx.shop.id, detail.jobId, ctx.profile.id, {
                    kind: work.kind,
                    hours: Number(work.hours),
                    workedOn: work.workedOn,
                    note: work.note.trim() || null,
                  }),
                )
              }
            >
              Log it
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setMode('none')}>
              Cancel
            </button>
            <span className="hint" style={{ marginTop: 0 }}>
              Your own hours at your own rate. This is the line that decides whether the job made
              money, and the one nobody writes down.
            </span>
          </div>
        </div>
      )}

      {(detail.runs.length > 0 || detail.work.length > 0) && (
        <div style={{ marginTop: 12 }}>
          {detail.runs.map((r) => (
            <div key={r.id} className="histitem">
              <span
                style={{
                  color:
                    r.outcome === 'failed'
                      ? 'var(--red)'
                      : r.outcome === 'cancelled'
                        ? 'var(--warn)'
                        : 'var(--ok)',
                }}
              >
                {r.outcome === 'success' ? '✓' : r.outcome === 'failed' ? '✕' : '−'}
              </span>
              <span style={{ color: 'var(--txt)' }}>
                {r.unitsUsed ?? 0}
                {r.unit ?? 'g'} · {r.hours ?? 0}h
              </span>
              <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>
                {r.printerName ?? 'machine gone'} · {r.materialName ?? 'material gone'}
                {r.startedAt ? ` · ${r.startedAt.slice(0, 10)}` : ''}
                {r.operator ? ` · ${r.operator}` : ''}
              </span>
              <button
                type="button"
                className="linkbtn"
                style={{ marginLeft: 'auto', fontSize: 11 }}
                disabled={saving}
                title="Remove this run. Its material goes back on the shelf."
                onClick={() => void guard(() => deletePrintRun(ctx.shop.id, r.id))}
              >
                remove
              </button>
              {r.failureReason && <div className="histnote">{r.failureReason}</div>}
            </div>
          ))}
          {detail.work.map((w) => (
            <div key={w.id} className="histitem">
              <span style={{ color: 'var(--info)' }}>◷</span>
              <span style={{ color: 'var(--txt)' }}>
                {w.hours}h {WORK_KIND_LABEL[w.kind].toLowerCase()}
              </span>
              <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>
                {w.workedOn}
                {w.actor ? ` · ${w.actor}` : ''}
              </span>
              <button
                type="button"
                className="linkbtn"
                style={{ marginLeft: 'auto', fontSize: 11 }}
                disabled={saving}
                onClick={() => void guard(() => deleteWorkEntry(ctx.shop.id, w.id))}
              >
                remove
              </button>
              {w.note && <div className="histnote">{w.note}</div>}
            </div>
          ))}
          <div className="hint" style={{ marginTop: 6 }}>
            {detail.runs.length} run{detail.runs.length === 1 ? '' : 's'} ·{' '}
            {(detail.actuals.designHours + detail.actuals.finishingHours + detail.actuals.adminHours)}
            h logged · {money(detail.actuals.materialCost)} of material off the shelf
          </div>
        </div>
      )}
    </div>
  )
}

function FlagPanel({ flags }: { flags: Flag[] }) {
  return (
    <div
      className="pane"
      style={{
        marginTop: 14,
        marginBottom: 0,
        borderColor: 'color-mix(in srgb, var(--red) 34%, transparent)',
      }}
    >
      <h3 style={{ color: 'var(--txt-2)' }}>
        {flags.length} flag{flags.length === 1 ? '' : 's'} · why, and what to do
      </h3>
      {flags.map((f) => (
        <div key={f.key} className="flagrow">
          <span className={`flagtag ${f.tone}`}>{f.label}</span>
          <div>
            <div className="fw">{f.cause}</div>
            <div className="fa">{f.action}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function GateRow({
  item,
  onToggle,
  onNote,
}: {
  item: ResolvedGateItem
  onToggle: (checked: boolean) => void
  onNote: (text: string) => void
}) {
  const id = `g-${item.key}`
  return (
    <div className="gwrap">
      <div className="gitem">
        <input
          id={id}
          type="checkbox"
          checked={item.checked}
          disabled={item.automatic}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <label className="lab" htmlFor={id}>
          {item.label}
          {item.needsNote && <span className="req"> *</span>}
        </label>
        <span className="gwho">{item.automatic ? item.autoFrom : item.checked ? 'ticked' : ''}</span>
      </div>
      <div className="hint" style={{ paddingLeft: 24, marginTop: 0 }}>
        {item.why}
      </div>
      {/* A starred item is one where a bare tick would be a lie waiting to
          happen. The note is the whole value of ticking it. */}
      {item.needsNote && item.checked && !item.automatic && (
        <textarea
          className={`gnote ${item.noteMissing ? 'miss' : ''}`}
          defaultValue={item.note ?? ''}
          placeholder="Say what actually happened — this is the bit you will need in three months."
          onBlur={(e) => onNote(e.target.value)}
        />
      )}
      {/* An item that cannot be ticked MUST say where to go and change the
          thing it is reading. Saying only where it reads from is how a
          project ends up permanently stuck on a checkbox. */}
      {item.automatic && !item.checked && (
        <div className="hint" style={{ paddingLeft: 24, color: 'var(--warn)' }}>
          {item.fix ?? `Clears on its own ${item.autoFrom ?? ''}`.trim()}
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone = '',
}: {
  label: string
  value: string
  sub?: string
  tone?: string
}) {
  return (
    <div>
      <div className="lbl">{label}</div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 18,
          color: tone === 'crit' ? 'var(--red)' : tone === 'ok' ? 'var(--ok)' : 'var(--txt)',
        }}
      >
        {value}
      </div>
      {sub && (
        <div className="hint" style={{ marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

const PRIORITIES: JobPriority[] = ['low', 'medium', 'high', 'urgent']

function PrioritySelect({
  value,
  disabled,
  onChange,
}: {
  value: JobPriority
  disabled: boolean
  onChange: (p: JobPriority) => void
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span style={{ color: 'var(--txt-3)' }}>Priority</span>
      <select
        value={value}
        disabled={disabled}
        style={{ width: 'auto' }}
        onChange={(e) => onChange(e.target.value as JobPriority)}
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </label>
  )
}

// GATES is imported for its type only in this file today, but keeping the
// import honest means a future "what will this stage ask for?" preview has
// the definitions to hand without another round of plumbing.
void GATES
