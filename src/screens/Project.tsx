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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  matchMaterial,
  matchPrinter,
  parseSliceFile,
  SLICE_ACCEPT,
  type SliceFile,
} from '../lib/sliceImport'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  CLIENT_KIND_LABEL,
  PAYMENT_KINDS,
  PAYMENT_KIND_LABEL,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  PART_STATUS_LABEL,
  WORK_KINDS,
  WORK_KIND_LABEL,
  addPart,
  addProjectNote,
  importSlice,
  deleteSliceImport,
  sliceFileContent,
  archiveProject,
  setRelatedProject,
  listJobs,
  type JobListRow,
  deletePart,
  updatePart,
  choosePartVariant,
  setPartStatus,
  deletePrintRun,
  deleteWorkEntry,
  loadProjectDetail,
  logWork,
  recordPrintRun,
  setQuoteStatus,
  takeProjectIn,
  createInHouseJob,
  deleteProject,
  recordPayment,
  setGateItem,
  updateJobPhase,
  updateProjectFields,
  listShelf,
  saveBatch,
  saveProduct,
  type ProductRow,
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
  ladderFor,
  phaseLabel,
  flagsFor,
  gateStatus,
  phaseIndex,
  type Flag,
  type ResolvedGateItem,
} from '../lib/gates'
import { useRowAnchor } from '../lib/rowAnchor'
import { mb, packFile, tooBigNote, unpackFile, type KeptFile } from '../lib/sliceFile'
import {
  allowedStatuses,
  buildingPhase,
  chosenVariant,
  isOnSharedPlate,
  failureTally,
  reprintCount,
  reprintNote,
  reprintReason,
  shouldReturnToBuilding,
  timeSpreadPct,
} from '../lib/parts'
import { makeMoney } from '../lib/pricing'
import { todayISO, formatDate } from '../lib/dates'
import { groupSliceFiles, machineFor, type FileGroup } from '../lib/fromFiles'
import { startBy } from '../lib/schedule'
import { defaultOpen, readFolds, writeFolds, type FoldScope } from '../lib/folds'
import {
  ancestorsOf,
  childrenOf,
  descendantsOf,
  eligibleParents,
  pathLabel,
  programTotals,
} from '../lib/programs'
import { buildComparison, type Comparison } from '../lib/actuals'
import { splitJobCost, unitCostFrom } from '../lib/selling'

const DELIVERY_METHODS = [
  'Collected in person',
  'Hand-delivered',
  'Courier',
  'Post',
  'Digital files only',
]

/**
 * Which sections are open on this screen, remembered between visits.
 *
 * One state object rather than a hook per section: the sections are
 * rendered in one component, and eight independent pieces of state that
 * all write the same key would race each other.
 */
function useFolds(scope: FoldScope) {
  const [state, setState] = useState<Record<string, boolean>>(() => readFolds(scope))
  // A project moving from live to done changes what should be open, so the
  // remembered state is re-read when the scope changes.
  useEffect(() => setState(readFolds(scope)), [scope])
  return {
    isOpen: (id: string) => state[id] ?? defaultOpen(scope, id),
    set: (id: string, open: boolean) =>
      setState((prev) => {
        const next = { ...prev, [id]: open }
        writeFolds(scope, next)
        return next
      }),
  }
}

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
  // Finished projects open differently from live ones: a delivered project
  // is a record behind a summary, not a control panel.
  const fold = useFolds(detail?.phase === 'delivered' ? 'done' : 'live')

  const rates = useMemo(() => toRateSet(ctx.rateCard, ctx.shop), [ctx.rateCard, ctx.shop])
  const { money } = useMemo(() => makeMoney(rates.currency, rates.locale), [rates])

  /** Every project, for the program tree -- the path above this one and
   *  everything under it. See lib/programs.ts. */
  const [allRows, setAllRows] = useState<JobListRow[] | null>(null)

  const reload = useCallback(async () => {
    try {
      const [d, rows] = await Promise.all([
        loadProjectDetail(ctx.shop.id, jobId),
        listJobs(ctx.shop.id),
      ])
      setDetail(d)
      setAllRows(rows)
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
  const unrecordedFiles = groupSliceFiles(detail.slices, detail.runs).filter((g) => !g.recorded).length
  // Only client work can be a draft. A draft is a price nobody has agreed
  // to; the shop's own work has neither, and treating it as one hid every
  // in-house project from the board (see 0022_inhouse_live.sql). The data
  // is fixed at the source -- this is the backstop, so that no other path
  // that creates in-house work can bring the bug back on screen.
  const isDraft = !facts.takenInAt && facts.kind !== 'inhouse'
  const flags = flagsFor(facts)
  const gate = gateStatus(shown, detail.gates[shown] ?? {}, facts)
  const liveGate =
    shown === detail.phase ? gate : gateStatus(detail.phase, detail.gates[detail.phase] ?? {}, facts)

  async function patch(fields: ProjectFieldsInput) {
    setBusy(true)
    try {
      await updateProjectFields(ctx.shop.id, jobId, fields, ctx.profile.id)
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

  /** Back a stage, or several. Something needs fixing; the reason is
   *  required and goes in Activity with the move. */
  async function moveBack(to: JobPhase, why: string) {
    setBusy(true)
    try {
      await updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to, why)
      setViewPhase(null)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function takeIn() {
    setBusy(true)
    try {
      await takeProjectIn(ctx.shop.id, jobId, ctx.profile.id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function destroy() {
    setBusy(true)
    try {
      await deleteProject(ctx.shop.id, jobId)
      navigate('/projects', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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

  /**
   * Which ladder this job is climbing, and what its rungs are called.
   *
   * In-house work has three stages of its own -- Working, Made, Done --
   * because there is nobody to approve it, nothing to schedule against a
   * promise and nobody to hand it to. Walking a trial print past "Client
   * approval" is theatre, and a checklist that is theatre teaches people to
   * tick without reading. See lib/gates.ts.
   */
  const mine = detail.facts.kind === 'inhouse'
  const ladder = ladderFor(detail.facts.kind)
  const label = (p: JobPhase) => phaseLabel(p, detail.facts.kind)
  const here = phaseIndex(detail.phase, detail.facts.kind)

  return (
    <div className="wrap" style={{ paddingTop: 16, paddingBottom: 96 }}>
      <div style={{ marginBottom: 10 }}>
        <Link to="/projects" className="linkbtn" style={{ fontSize: 12, width: 'auto', display: 'inline' }}>
          ← Projects
        </Link>
        {/* Where this lives in a program. Each step is a link, so getting
            from Oʻahu back up to BathyTopo is one click, not a search. */}
        {allRows &&
          ancestorsOf(allRows, detail.jobId).map((a) => (
            <span key={a.jobId} style={{ fontSize: 12, color: 'var(--txt-3)' }}>
              {' › '}
              <Link to={`/project/${a.jobId}`} style={{ color: 'var(--txt-2)' }}>
                {a.title}
              </Link>
            </span>
          ))}
      </div>

      {/* ---- head: who, what, where in the process, what's wrong ---- */}
      <div className="dlg-title" style={{ alignItems: 'baseline' }}>
        <TitleEditor title={detail.title} busy={busy} onSave={(title) => patch({ title })} />
        <span className="pmeta">
          {detail.ref} · {detail.client.name} · {CLIENT_KIND_LABEL[detail.client.kind]}
          {detail.facts.poc ? ` · ${detail.facts.poc}` : ''}
          {detail.facts.neededBy ? ` · due ${detail.facts.neededBy}` : ' · no due date'}
        </span>
      </div>

      {/* A draft is deliberately not on the board. Saying so here, with the
          one action that changes it, is the difference between "where did my
          project go" and a decision someone made on purpose. */}
      {isDraft && (
        <div
          className="pane"
          style={{
            marginTop: 12,
            marginBottom: 0,
            borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)',
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600, color: 'var(--txt)' }}>Saved as a draft</div>
            <div style={{ fontSize: 12, color: 'var(--txt-2)', marginTop: 2 }}>
              Priced and saved, but not on the pipeline board and not counted as work you have
              agreed to. Take it in when it becomes real.
            </div>
          </div>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void takeIn()}>
            Take it into Intake →
          </button>
        </div>
      )}

      <div className="stepper" style={{ marginTop: 12, opacity: isDraft ? 0.45 : 1 }}>
        {ladder.map((p, i) => {
          // A stage behind this one that still has items outstanding was
          // not finished, it was left behind -- and a green tick on it
          // would say the opposite. gateStatus is already computed for
          // every stage on this screen, so this costs nothing.
          const left = i < here && gateStatus(p, detail.gates[p] ?? {}, facts).blocked
          return (
            <button
              key={p}
              type="button"
              className={`step ${i < here ? 'done' : ''} ${left ? 'open' : ''} ${
                p === shown ? 'cur' : ''
              }`
                .replace(/\s+/g, ' ')
                .trim()}
              style={{ cursor: 'pointer' }}
              aria-current={p === detail.phase ? 'step' : undefined}
              title={
                left
                  ? `${label(p)} — advanced past with items still open. Click to see which.`
                  : i < here
                    ? `${label(p)} — cleared. Click to review its gate.`
                    : i === here
                      ? `${label(p)} — where this project is now.`
                      : `${label(p)} — not reached yet. Click to see what it will ask for.`
              }
            >
              <i aria-hidden="true" />
              {label(p)}
            </button>
          )
        })}
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

      {facts.archivedAt && (
        <div className="attn" style={{ marginBottom: 10 }}>
          <b>Archived</b>
          <div style={{ marginTop: 4, fontSize: 12 }}>
            Filed off the board on {facts.archivedAt.slice(0, 10)}. Nothing was deleted and nothing
            stopped counting — it is still in the dashboard, in what this shop has earned, and in
            what its materials have cost.
          </div>
        </div>
      )}

      {/* ---- the family ---- */}
      <Program
        ctx={ctx}
        detail={detail}
        rows={allRows}
        busy={busy}
        open={fold.isOpen('program')}
        onToggle={(o) => fold.set('program', o)}
        onChanged={reload}
        setError={setError}
      />

      {/* ---- what it came to, once it is finished ---- */}
      {detail.phase === 'delivered' && (
        <Closeout detail={detail} money={money} locale={rates.locale} jobId={jobId} />
      )}

      {/* ---- flags, spelled out ---- */}
      {flags.length > 0 && (
        <FlagPanel
          flags={flags}
          busy={busy}
          onClear={(key) => (key === 'over-ceiling' ? patch({ overCeiling: null }) : undefined)}
        />
      )}

      {/* ---- what this project is ----
          Sits first because the intake gate reads the brief, and a fact a
          gate reads has to be changeable from the same screen that tells
          you it is blocking. It was not, and a project saved with an empty
          brief could never leave intake. */}
      <details className="sec fold" style={{ marginTop: 18 }}
        data-fold="brief"
        open={fold.isOpen('brief')}
        onToggle={(e) => fold.set('brief', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>The brief</h4>
          <span className={`secstat ${(detail.brief ?? '').trim().length >= 20 ? 'ok' : 'warn'}`}>
            {(detail.brief ?? '').trim() ? 'written down' : 'nothing written down'}
          </span>
        </summary>
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
      </details>

      {/* ---- the gate ---- */}
      <details className="sec fold" style={{ marginTop: 18 }}
        data-fold="gate"
        open={fold.isOpen('gate')}
        onToggle={(e) => fold.set('gate', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>
            {label(shown)}
            {gate.next ? ` — gate to ${label(gate.next)}` : ''}
          </h4>
          <span className={`secstat ${gate.total === 0 ? '' : gate.blocked ? 'warn' : 'ok'}`}>
            {gate.total === 0 ? 'no gate' : `${gate.done} of ${gate.total} cleared`}
          </span>
        </summary>

        {shown !== detail.phase && phaseIndex(shown, detail.facts.kind) < here && !isDraft && (
          <MoveBack
            to={label(shown)}
            busy={busy}
            onMove={(why) => moveBack(shown, why)}
          />
        )}
        {shown !== detail.phase && (
          <div className="hint" style={{ marginBottom: 6 }}>
            Looking at {label(shown)}, which is{' '}
            {phaseIndex(shown, detail.facts.kind) < here ? 'already behind you' : 'still ahead'}. Ticking here still
            records a real answer —{' '}
            <button type="button" className="linkbtn" onClick={() => setViewPhase(null)}>
              back to {label(detail.phase)}
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
            {/* What is actually stopping this, named and counted, BEFORE the
                list. The list was already correct -- every unticked item was
                on it -- but a list of eight where three matter is a list you
                read once and stop reading. This says which three. */}
            {(() => {
              const outstanding = gate.items.filter((i) => !i.checked)
              if (!outstanding.length) return null
              return (
                <div className="blockbar">
                  <h5>
                    {outstanding.length} thing{outstanding.length === 1 ? '' : 's'} left before{' '}
                    {gate.next ? label(gate.next) : 'this can advance'}
                  </h5>
                  <ol>
                    {outstanding.map((i) => (
                      <li key={i.key}>
                        {i.label}
                        {i.automatic && (
                          <>
                            {' — '}
                            <span style={{ color: 'var(--txt-3)' }}>
                              {i.fix ?? `clears on its own ${i.autoFrom ?? ''}`.trim()}
                            </span>
                          </>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )
            })()}
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
      </details>

      {/*
        Three sections below exist only for work somebody is paying for.
        Money, a promised window and a handover are not "empty" on a trial
        print -- they do not apply at all, and showing them as unfilled
        turns the page into a list of things you have failed to do. The
        whole complaint about this program was too many options that do not
        apply; this is the same bug wearing a different hat.
      */}
      {!mine && (
        <>
      {/* ---- money ---- */}
      <details className="sec fold"
        data-fold="money"
        open={fold.isOpen('money')}
        onToggle={(e) => fold.set('money', e.currentTarget.open)}
      >
        <summary className="sechead">
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
        </summary>
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
                {detail.quote && (
                  <Link
                    to={`/intake?revise=${detail.jobId}`}
                    className="btn sm"
                    style={{ textDecoration: 'none' }}
                    title={
                      detail.quote.status === 'accepted'
                        ? 'Prices a new version against this project. The accepted one stays exactly as the client saw it, and above 10% over it you will be asked what the client changed.'
                        : 'Prices a new version against this project.'
                    }
                  >
                    Revise the quote
                  </Link>
                )}
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
      </details>

      {/* ---- the promise ---- */}
      <details className="sec fold"
        data-fold="people"
        open={fold.isOpen('people')}
        onToggle={(e) => fold.set('people', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>Who and when</h4>
          <span className={`secstat ${facts.windowLocked ? 'ok' : 'warn'}`}>
            {facts.windowLocked ? 'committed' : 'still moveable'}
          </span>
        </summary>
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
      </details>

      {/* ---- what actually happened ---- */}
      <details className="sec fold"
        data-fold="handover"
        open={fold.isOpen('handover')}
        onToggle={(e) => fold.set('handover', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>Handover</h4>
          <span className={`secstat ${facts.deliveryOn ? 'ok' : ''}`}>
            {facts.deliveryOn ? `handed over ${facts.deliveryOn}` : 'not yet delivered'}
          </span>
        </summary>
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
      </details>

        </>
      )}

      {/*
        The build sheet is NOT inside the !mine block above, and the reason
        is worth stating because it was inside it until now.

        Money, a promised window and a handover genuinely do not apply to a
        shop's own trial print -- that is the whole point of that block. The
        build sheet is different: a prototype has parts, a test plate has
        parts, and an R&D print that fails twice has cost the shop material
        and machine time exactly as a client's would. It was hidden only
        because it happened to sit inside the same fragment, which also
        meant slicer import was unreachable on in-house work -- the work
        most likely to be sliced and re-sliced.
      */}
      <details className="sec fold"
        data-fold="build"
        open={fold.isOpen('build')}
        onToggle={(e) => fold.set('build', e.currentTarget.open)}
      >
        <summary className="sechead">
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
        </summary>
        <StartByLine detail={detail} locale={rates.locale} />
        <BuildSheet
          ctx={ctx}
          detail={detail}
          locked={phaseIndex(detail.phase) >= phaseIndex('review')}
          busy={busy}
          onChanged={reload}
          setError={setError}
        />
      </details>

      {/* ---- what it actually took ---- */}
      <details className="sec fold"
        data-fold="actuals"
        open={fold.isOpen('actuals')}
        onToggle={(e) => fold.set('actuals', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>What it actually took</h4>
          <span
            className={`secstat ${
              unrecordedFiles > 0
                ? 'warn'
                : mine
                ? ''
                : comparison === null
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
            {unrecordedFiles > 0
              ? `${unrecordedFiles} sliced file${unrecordedFiles === 1 ? '' : 's'} not recorded yet`
              : mine
              ? detail.facts.hasActuals
                ? `${money(detail.facts.actualCost)} spent so far`
                : 'nothing recorded yet'
              : comparison === null
                ? 'needs a quote'
                : !comparison.hasActuals
                  ? 'nothing recorded yet'
                  : comparison.partial
                    ? 'partly recorded'
                    : `real margin ${money(comparison.actualMargin ?? 0)}`}
          </span>
        </summary>
        <div className="pane" style={{ marginBottom: 0 }}>
          {/*
            An in-house job has no quote and never will, so "there is
            nothing to compare against until this has a quote" would be a
            permanent, useless sentence. What its cost compares against is
            what it produced -- which is the section directly below.
          */}
          {mine ? (
            <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
              Nobody is paying for this, so there is no quote to measure it against. What it cost is
              measured against what it made instead — log the runs and hours here, then record what
              came out of it below.
            </div>
          ) : comparison === null ? (
            <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
              There is nothing to compare against until this project has a quote. Runs and hours can
              still be logged below — they will line up once it does.
            </div>
          ) : (
            <Variance comparison={comparison} money={money} />
          )}

          <FromTheFiles ctx={ctx} detail={detail} busy={busy} onChanged={reload} setError={setError} />

          <RunLog
            ctx={ctx}
            detail={detail}
            money={money}
            busy={busy}
            onChanged={reload}
            setError={setError}
          />
        </div>
      </details>

      {/* ---- what it made, for the shop's own work ---- */}
      {detail.facts.kind === 'inhouse' && (
        <MadeSection
          ctx={ctx}
          detail={detail}
          money={money}
          onSaved={reload}
          setError={setError}
        />
      )}

      {/* ---- activity ---- */}
      <details className="sec fold"
        data-fold="activity"
        open={fold.isOpen('activity')}
        onToggle={(e) => fold.set('activity', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>Activity</h4>
          <span className="secstat">
            {detail.events.length} entr{detail.events.length === 1 ? 'y' : 'ies'}
          </span>
        </summary>
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
                  {e.kind === 'phase_change' ? ' · stage change' : e.kind === 'edit' ? ' · edit' : ''}
                </div>
                {e.kind === 'phase_change'
                  ? `Moved ${
                      phaseIndex(e.toPhase ?? 'intake', detail.facts.kind) <
                      phaseIndex(e.fromPhase ?? 'intake', detail.facts.kind)
                        ? 'back '
                        : ''
                    }from ${label(e.fromPhase ?? 'intake')} to ${label(e.toPhase ?? 'intake')}.${
                      e.body ? ` Why: ${e.body}` : ''
                    }`
                  : (e.body ?? '')}
              </div>
            ))}
          </div>
        </div>
      </details>

      {/* ---- earlier stages ---- */}
      <section className="sec">
        <div className="sechead">
          <h4>Earlier stages</h4>
          <span className="secstat">{here === 0 ? 'none yet' : `${here} behind this one`}</span>
        </div>
        <div className="stack">
          {/* This job's OWN ladder, not the client one. A trial print
              climbs three stages, and listing the seven client stages
              behind it offered "Client approval" on work with no client. */}
          {ladder.slice(0, here).map((p) => {
            const g = gateStatus(p, detail.gates[p] ?? {}, facts)
            return (
              <details key={p}>
                <summary>
                  <span className="caret">▸</span>
                  <b>{label(p)}</b>
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
          {!isDraft
            ? liveGate.reason
            : 'A draft has no gate to clear — nothing is being tracked against it until it is taken in.'}
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
        {/* Archiving, only once it is finished. The board is a list of what
            needs attention; a delivered project from March needs none, and
            leaving it there is how a board stops being read. Nothing is
            deleted and nothing stops counting. */}
        {detail.phase === 'delivered' && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            title={
              facts.archivedAt
                ? 'Puts it back on the board.'
                : 'Files it off the board. Every figure it contributes still counts — the dashboard, the shop’s own history, what a material has cost on average.'
            }
            onClick={() =>
              void (async () => {
                setBusy(true)
                try {
                  await archiveProject(ctx.shop.id, jobId, ctx.profile.id, !facts.archivedAt)
                  await reload()
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setBusy(false)
                }
              })()
            }
          >
            {facts.archivedAt ? 'Unarchive' : 'Archive'}
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => navigate('/projects')}
          style={{ textDecoration: 'none' }}
        >
          Back to projects
        </button>
        <DeleteProject detail={detail} busy={busy} onConfirm={destroy} />
        {!isDraft && here > 0 && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            title="Something needs fixing? Open the earlier stage and say why."
            onClick={() => {
              setViewPhase(ladder[here - 1])
              fold.set('gate', true)
              window.scrollTo?.({ top: 0, behavior: 'smooth' })
            }}
          >
            ← Back to {label(ladder[here - 1])}
          </button>
        )}
        {!isDraft ? (
          <button
            type="button"
            className="btn primary advance"
            disabled={busy || liveGate.blocked || liveGate.next === null}
            title={liveGate.blocked ? liveGate.reason : undefined}
            onClick={() => void advance()}
          >
            {liveGate.next
              ? `Advance to ${label(liveGate.next)} →`
              : label(detail.phase)}
          </button>
        ) : (
          <button
            type="button"
            className="btn primary advance"
            disabled={busy}
            title="Puts it on the board at Intake and starts the gates."
            onClick={() => void takeIn()}
          >
            Take it into Intake →
          </button>
        )}
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
  const [when, setWhen] = useState(todayISO)
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
/**
 * Import a sliced file into the build sheet.
 *
 * The shape of this is the point. A slicer file is EVIDENCE, not an
 * instruction: it is read, shown in full, and only written once somebody
 * has looked at it and pressed a button. Nothing here saves on file
 * selection, because the one thing worse than typing the build set by hand
 * is a build set that appeared by itself and is subtly wrong.
 *
 * What it will not do:
 *   - It does not record a print. An import writes no print_run, so the
 *     project's actual cost does not move. See 0015_slice_imports.sql.
 *   - It does not guess between two machines or two spools of one type.
 *     matchPrinter and matchMaterial return null instead, and the selects
 *     below open on "not matched" so the omission is visible rather than
 *     quietly wrong.
 */
function SliceImport({
  ctx,
  detail,
  busy,
  onChanged,
  onImported,
  setError,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  busy: boolean
  onChanged: () => Promise<void>
  /** Tells the build sheet to mark the rows that just arrived. */
  onImported: (n: number) => void
  setError: (m: string | null) => void
}) {
  const [read, setRead] = useState<SliceFile | null>(null)
  /** The file's own bytes, packed for storage. Null when it was over the
   *  cap -- the import still goes ahead, and `tooBig` says so. */
  const [kept, setKept] = useState<KeptFile | null>(null)
  const [tooBig, setTooBig] = useState<string | null>(null)
  const [printerId, setPrinterId] = useState('')
  const [materialId, setMaterialId] = useState('')
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)
  /** What the last import did, in a sentence. Without this an import is
   *  silent: the rows appear somewhere below and nothing says the file was
   *  read, which reads as "nothing happened". */
  const [done, setDone] = useState<string | null>(null)
  /**
   * Asked once, at import: has this file already been printed? Most files
   * arrive AFTER the plate came off -- that is when people remember to log
   * them -- so the default is yes. Checked, one step writes the run from
   * the file's own numbers: machine hours, filament off the shelf, the
   * plate's parts marked printed. Unchecked, the file waits under "Sliced
   * files" as an estimate until someone records it.
   */
  const [printedNow, setPrintedNow] = useState(true)
  const [printedOn, setPrintedOn] = useState(todayISO)
  const fileRef = useRef<HTMLInputElement>(null)

  async function pick(file: File | undefined) {
    if (!file) return
    setError(null)
    setDone(null)
    try {
      const parsed = await parseSliceFile(file)
      setRead(parsed)
      // Keep the file itself, not only what it said. Reported by CG: "I
      // already uploaded the file that was used to print the piece and
      // it's not there anymore" -- it never was. Packing cannot fail the
      // import: the numbers are the part that matters.
      const bytes = new Uint8Array(await file.arrayBuffer())
      const packed = await packFile(bytes)
      setKept(packed)
      setTooBig(packed ? null : tooBigNote(bytes.byteLength))
      setPrinterId(matchPrinter(ctx.printerRows, parsed.printerModel)?.id ?? '')
      setMaterialId(matchMaterial(ctx.materials, parsed.totals.material)?.id ?? '')
    } catch (e) {
      setRead(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function clear() {
    setRead(null)
    setKept(null)
    setTooBig(null)
    setDragging(false)
    setPrinterId('')
    setMaterialId('')
    // Without this the same file cannot be picked twice in a row: the input
    // fires change only when the value differs.
    if (fileRef.current) fileRef.current.value = ''
  }

  async function confirm() {
    if (!read) return
    setSaving(true)
    setError(null)
    try {
      const res = await importSlice(ctx.shop.id, detail.jobId, ctx.profile.id, {
        file: kept,
        fileName: read.fileName,
        kind: read.kind,
        printerModel: read.printerModel,
        printerId: printerId || null,
        materialText: read.totals.material,
        materialId: materialId || null,
        estMinutes: read.totals.estMinutes,
        estGrams: read.totals.estGrams,
        notes: read.notes,
        sections: read.sections.map((sec) => ({
          label: sec.label,
          qty: sec.qty,
          estMinutes: sec.estMinutes,
          estGrams: sec.estGrams,
          material: sec.material,
        })),
      })
      let recorded: string | null = null
      const alreadyRecorded =
        !!res.duplicateOf && detail.runs.some((r) => r.sliceImportId === res.importId)
      if (alreadyRecorded) {
        recorded = 'Its print was already recorded, so nothing was counted twice.'
      } else if (printedNow && printerId) {
        const grams = read.totals.estGrams == null ? 0 : Math.round(read.totals.estGrams)
        const hours =
          read.totals.estMinutes == null ? 0 : Math.round((read.totals.estMinutes / 60) * 100) / 100
        await recordPrintRun(ctx.shop.id, detail.jobId, ctx.profile.id, {
          printerId,
          materialId: materialId || null,
          unitsUsed: materialId ? grams : 0,
          hours,
          outcome: 'success',
          failureReason: null,
          note: `From ${read.fileName}`,
          startedAt: printedOn || todayISO(),
          sliceImportId: res.importId,
        })
        // The plate came off, so every object on it came off.
        const fresh = await loadProjectDetail(ctx.shop.id, detail.jobId)
        let marked = 0
        if (allowedStatuses(fresh.phase, fresh.facts.kind).includes('printed')) {
          const slice = fresh.slices.find((x) => x.id === res.importId)
          const ids = new Set(slice?.sections.map((sec) => sec.partId).filter(Boolean))
          for (const part of fresh.parts) {
            if (ids.has(part.id) && part.status === 'pending') {
              await setPartStatus(ctx.shop.id, part.id, ctx.profile.id, 'printed', null)
              marked++
            }
          }
        }
        const machine = ctx.printerRows.find((p) => p.id === printerId)?.name ?? 'the machine'
        recorded =
          `Recorded as printed on ${machine}: ${hrs(read.totals.estMinutes) ?? '0h'}` +
          (materialId ? `, ${grams} g off the shelf` : ', no material matched so nothing came off the shelf') +
          (marked ? `, ${marked} part${marked === 1 ? '' : 's'} marked printed` : '') +
          '.'
      }
      const bits: string[] = []
      if (res.duplicateOf)
        bits.push(`already on this project since ${res.duplicateOf.slice(0, 10)}, not added again`)
      if (res.partsAdded) bits.push(`${res.partsAdded} part${res.partsAdded === 1 ? '' : 's'} added`)
      if (res.partsMatched)
        bits.push(
          `${res.partsMatched} already on the sheet, estimate updated`,
        )
      setDone(
        `${read.fileName} — ${bits.join(' · ') || 'read, nothing to add'}${
          kept ? ', file kept' : ''
        }. ` +
          (recorded ??
            'It is listed under “Sliced files” below; record it as printed when it comes off the ' +
              'machine and the filament comes off the shelf.'),
      )
      onImported(res.partsAdded + res.partsMatched)
      clear()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const hrs = (m: number | null) =>
    m == null ? null : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`

  return (
    <div style={{ marginTop: 12 }}>
      {done && (
        <div className="landed-note hint" style={{ marginTop: 0, marginBottom: 10, color: 'var(--ok)' }}>
          {done}
        </div>
      )}

      {/* A label wrapping a visually-hidden input, so the whole box is the
          control: clickable, focusable, and announced as a file input. A
          div with an onClick would be none of those. */}
      <label
        className={`drop ${dragging ? 'over' : ''}`}
        htmlFor="slice-file"
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void pick(e.dataTransfer.files?.[0])
        }}
      >
        <span className="dropicon" style={{ fontSize: 22, display: 'block', marginBottom: 6 }}>
          ⤓
        </span>
        <span className="drop-title">
          {dragging ? 'Drop it' : 'Drop a sliced file here, or click to choose one'}
        </span>
        <span className="drop-sub">
          .gcode.3mf from Bambu Studio or Orca · .gcode from PrusaSlicer
        </span>
        <input
          id="slice-file"
          ref={fileRef}
          type="file"
          // The visible label changes while a file is over the box ("Drop
          // it"), which would make the accessible name change mid-drag. A
          // fixed aria-label keeps the control's name stable for anyone
          // using a screen reader, and for the tests.
          aria-label="Import a sliced file"
          accept={SLICE_ACCEPT}
          disabled={busy || saving}
          onChange={(e) => void pick(e.target.files?.[0])}
          // Visually hidden, NOT disabled for the pointer. pointer-events:
          // none here stops the input being clicked or dropped on at all,
          // which breaks both the control and every test that drives it.
          // The wrapping label is what the person actually clicks.
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
        />
      </label>
      <div className="hint" style={{ marginTop: 6 }}>
        Guma reads the objects on the plate, the machine and the filament, and shows you before
        writing anything. You choose whether it has already been printed; if not, it waits as an
        estimate until you record it.
      </div>

      {read && (
        <div className="pane" style={{ marginTop: 10 }}>
          <div className="sechead">
            <h4>{read.fileName}</h4>
            <span className="sub">
              {read.totals.sections} section{read.totals.sections === 1 ? '' : 's'} ·{' '}
              {read.totals.units} cop{read.totals.units === 1 ? 'y' : 'ies'}
              {read.totals.estGrams != null && ` · ~${read.totals.estGrams} g`}
              {read.totals.estMinutes != null && ` · ~${hrs(read.totals.estMinutes)}`}
            </span>
          </div>

          <div className="sheetwrap" style={{ maxHeight: 260 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '50%' }}>Part</th>
                  <th className="r">Copies</th>
                  <th className="r">Est. grams</th>
                  <th className="r">Est. time</th>
                </tr>
              </thead>
              <tbody>
                {read.sections.map((sec) => (
                  <tr key={sec.label}>
                    <td>
                      <span className="pn">{sec.label}</span>
                    </td>
                    <td className="r">{sec.qty}</td>
                    <td className="r">{sec.estGrams ?? '—'}</td>
                    <td className="r">{hrs(sec.estMinutes) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="btnrow" style={{ marginTop: 10, alignItems: 'flex-end' }}>
            <div className="fld" style={{ margin: 0, flex: 1, minWidth: 180 }}>
              <label className="lbl" htmlFor="slice-printer">
                Machine{read.printerModel ? ` — file says “${read.printerModel}”` : ''}
              </label>
              <select
                id="slice-printer"
                value={printerId}
                onChange={(e) => setPrinterId(e.target.value)}
              >
                <option value="">Not matched</option>
                {ctx.printerRows.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.model ? ` · ${p.model}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld" style={{ margin: 0, flex: 1, minWidth: 180 }}>
              <label className="lbl" htmlFor="slice-material">
                Material{read.totals.material ? ` — file says “${read.totals.material}”` : ''}
              </label>
              <select
                id="slice-material"
                value={materialId}
                onChange={(e) => setMaterialId(e.target.value)}
              >
                <option value="">Not matched</option>
                {ctx.materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {tooBig && (
            <div className="hint" style={{ marginTop: 6, color: 'var(--warn)' }}>
              {tooBig}
            </div>
          )}
          {kept && (
            <div className="hint" style={{ marginTop: 6 }}>
              The file itself will be kept with the project — {mb(kept.byteSize)}, stored as{' '}
              {mb(kept.storedSize)}. Reprinting in eight months means reprinting THIS file, not one
              with the same name.
            </div>
          )}
          {read.notes.map((n) => (
            <div className="hint" key={n} style={{ marginTop: 6 }}>
              {n}
            </div>
          ))}

          <div className="btnrow" style={{ marginTop: 10, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={printedNow}
                onChange={(e) => setPrintedNow(e.target.checked)}
              />
              Already printed — record it now
            </label>
            {printedNow && (
              <input
                type="date"
                aria-label="Printed on"
                value={printedOn}
                onChange={(e) => setPrintedOn(e.target.value)}
                style={{ width: 150 }}
              />
            )}
          </div>
          {printedNow && (
            <div className="hint" style={{ marginTop: 4 }}>
              {printerId
                ? `Writes the run from the file: ${hrs(read.totals.estMinutes) ?? 'no time in the file'} on the machine` +
                  (materialId
                    ? `, ${read.totals.estGrams == null ? 0 : Math.round(read.totals.estGrams)} g off the shelf, `
                    : ', no material matched — pick one or nothing comes off the shelf, ') +
                  'plate parts marked printed. If the real print differed, remove the run under “Sliced files” and record it again.'
                : 'Pick the machine it printed on — a print run needs one.'}
            </div>
          )}

          <div className="btnrow" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || saving || (printedNow && !printerId)}
              onClick={() => void confirm()}
            >
              {printedNow ? 'Add to the build sheet and record the print' : `Add ${read.totals.sections} section${read.totals.sections === 1 ? '' : 's'} to the build sheet`}
            </button>
            <button type="button" className="btn sm" disabled={saving} onClick={clear}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The imported files, and the one button that turns an estimate into an
 * actual.
 *
 * This is the half 0015 left out on purpose and the half the shop actually
 * feels. An import fills the build sheet and records what the slicer
 * predicted; nothing comes off the shelf, because an estimate is not a
 * measurement. But when the plate DOES come off the bed, the numbers the
 * file already knows -- grams, machine hours, which machine, which spool --
 * are exactly the numbers the run form asks you to retype. Retyping them is
 * how a shop ends up with a material count that drifts and a fleet whose
 * hours are guesses.
 *
 * So: one button per file. It opens the run pre-filled from the file, you
 * say whether it came off clean, and recording it deducts the filament
 * (the t_run_consume trigger does that) and lands the hours in job_actuals.
 *
 * Voltage's rule is kept: a failure is a run too. It burned the same
 * material and the same hours, it wants a reason, and the file stays
 * available to record again once the reprint is done -- which is why the
 * "already recorded" note counts runs rather than hiding the file.
 */
function SliceRuns({
  ctx,
  detail,
  busy,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  busy: boolean
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<PrintRunInput | null>(null)
  /**
   * Plate dispatch. A plate holding four objects is ONE print that
   * produces four parts, so the four rows on the build sheet move
   * together. Voltage learned this the other way round -- it reserved and
   * marked parts one at a time, which understated every plate job and
   * left rows sitting at "pending" long after the object was in a box.
   *
   * Default on, because that is what happened. Turned off for the case
   * where you lifted one object off the plate and left the rest.
   */
  const [markParts, setMarkParts] = useState(true)
  const [removing, setRemoving] = useState<string | null>(null)

  /**
   * Write the kept file back out.
   *
   * An object URL and a click, which is what a webview gives us -- there
   * is no save dialog to call. It lands wherever downloads land.
   */
  async function saveCopy(importId: string, fileName: string) {
    setSaving(true)
    setError(null)
    try {
      const row = await sliceFileContent(ctx.shop.id, importId)
      if (!row) throw new Error('That file was not kept — only what it said.')
      const bytes = await unpackFile(row.content)
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]))
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Let the click start before the URL stops being valid.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function remove(importId: string) {
    setSaving(true)
    setError(null)
    try {
      await deleteSliceImport(ctx.shop.id, importId)
      setRemoving(null)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (detail.slices.length === 0) return null

  const hrs = (m: number | null) =>
    m == null ? null : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`

  function open(s: (typeof detail.slices)[number]) {
    setError(null)
    setOpenId(s.id)
    setForm({
      // A run needs a machine. The import may not have matched one, in
      // which case the select opens empty and the button stays disabled
      // rather than picking the first printer in the list for you.
      printerId: s.printerId ?? '',
      materialId: s.materialId,
      // Rounded to whole grams and to a quarter hour, because that is the
      // precision the rest of the app stores and a run that reads
      // "7.483333h" looks like it was measured when it was predicted.
      unitsUsed: s.estGrams == null ? 0 : Math.round(s.estGrams),
      hours: s.estMinutes == null ? 0 : Math.round((s.estMinutes / 60) * 100) / 100,
      outcome: 'success',
      failureReason: null,
      note: `From ${s.fileName}`,
      startedAt: todayISO(),
      sliceImportId: s.id,
    })
  }

  /** The parts this file produced that the build sheet still calls
   *  pending, and that this stage allows to be marked printed. */
  function pendingPartsOf(importId: string): string[] {
    if (!allowedStatuses(detail.phase, detail.facts.kind).includes('printed')) return []
    const slice = detail.slices.find((x) => x.id === importId)
    if (!slice) return []
    const ids = new Set(slice.sections.map((sec) => sec.partId).filter((x): x is string => !!x))
    return detail.parts.filter((p) => ids.has(p.id) && p.status === 'pending').map((p) => p.id)
  }

  async function record() {
    if (!form) return
    setSaving(true)
    setError(null)
    try {
      await recordPrintRun(ctx.shop.id, detail.jobId, ctx.profile.id, form)
      // The plate came off, so every object on it came off. Only on a
      // successful run: a failed plate produced nothing to check.
      if (markParts && form.outcome === 'success' && form.sliceImportId) {
        for (const partId of pendingPartsOf(form.sliceImportId)) {
          await setPartStatus(ctx.shop.id, partId, ctx.profile.id, 'printed', null)
        }
      }
      setOpenId(null)
      setForm(null)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const unit = ctx.materials.find((m) => m.id === form?.materialId)?.unit ?? 'g'

  return (
    <div style={{ marginTop: 14 }}>
      <div className="sechead">
        <h4>Sliced files</h4>
        <span className="sub">
          What the slicer said. Record one as printed and the filament comes off the shelf.
        </span>
      </div>

      {detail.slices.map((s) => {
        const runs = detail.runs.filter((r) => r.sliceImportId === s.id)
        const used = runs.reduce((a, r) => a + (r.unitsUsed ?? 0), 0)
        const hours = runs.reduce((a, r) => a + (r.hours ?? 0), 0)
        const failed = runs.filter((r) => r.outcome !== 'success').length
        return (
          <div className="pane" key={s.id} style={{ marginTop: 8 }}>
            <div className="btnrow" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
              <div>
                <span className="pn">{s.fileName}</span>
                <span className="hint" style={{ marginTop: 2 }}>
                  {s.printerName ?? s.printerModel ?? 'machine not matched'}
                  {s.materialName ? ` · ${s.materialName}` : s.materialText ? ` · ${s.materialText}` : ''}
                  {s.estGrams != null && ` · ~${Math.round(s.estGrams)} g`}
                  {s.estMinutes != null && ` · ~${hrs(s.estMinutes)}`}
                  {` · imported ${s.importedAt.slice(0, 10)}`}
                </span>
              </div>
              {openId !== s.id && (
                <div className="btnrow" style={{ margin: 0 }}>
                  {s.keptBytes != null && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy || saving}
                      title={`Writes the stored file back out — ${mb(s.keptBytes)}, byte for byte the one that was imported.`}
                      onClick={() => void saveCopy(s.id, s.fileName)}
                    >
                      Save a copy
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn sm ${runs.length ? '' : 'primary'}`}
                    disabled={busy || saving}
                    onClick={() => open(s)}
                  >
                    {runs.length ? 'Record another run' : 'This print happened'}
                  </button>
                  {/* Removing an import is allowed and deliberately small.
                      A file imported onto the wrong project is the common
                      case, and the runs recorded from it STAY -- the print
                      still happened. See 0017_run_from_slice.sql. */}
                  <button
                    type="button"
                    className="linkbtn"
                    style={{ fontSize: 10, width: 'auto', marginTop: 0 }}
                    disabled={busy || saving}
                    // Named for the file: the build sheet below has a
                    // "remove" on every part row, and two controls with one
                    // name is how the wrong thing gets deleted.
                    aria-label={`Remove the file ${s.fileName}`}
                    onClick={() => setRemoving(removing === s.id ? null : s.id)}
                  >
                    remove
                  </button>
                </div>
              )}
            </div>

            <div className="hint" style={{ marginTop: 4 }}>
              {s.keptBytes != null ? (
                <>The file is kept with this project — {mb(s.keptBytes)}.</>
              ) : (
                <span style={{ color: 'var(--warn)' }}>
                  Only what this file said was kept, not the file. Imports from here on keep the
                  file itself; re-import it to store a copy.
                </span>
              )}
            </div>

            {removing === s.id && (
              <div className="attn crit" style={{ marginTop: 8 }}>
                <b>Remove {s.fileName}?</b>
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  This drops the import, its per-part estimates and the stored file.{' '}
                  {runs.length > 0
                    ? `The ${runs.length} run${runs.length === 1 ? '' : 's'} recorded from it stay — the print still happened, and its cost is real.`
                    : 'Nothing was recorded from it.'}{' '}
                  The parts it added to the build sheet stay too; remove those on the sheet if you
                  want them gone.
                </div>
                <div className="btnrow" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn sm danger"
                    disabled={saving}
                    onClick={() => void remove(s.id)}
                  >
                    {saving ? 'Removing…' : 'Remove it'}
                  </button>
                  <button type="button" className="btn sm" onClick={() => setRemoving(null)}>
                    Keep it
                  </button>
                </div>
              </div>
            )}

            {runs.length > 0 && (
              <div className="hint" style={{ marginTop: 6, color: 'var(--ok)' }}>
                Recorded — {runs.length} run{runs.length === 1 ? '' : 's'}, {Math.round(used)} off
                the spool, {Math.round(hours * 100) / 100} machine hours
                {failed > 0 && ` · ${failed} of them failed`}. The material is off the shelf and the
                hours are in this project&rsquo;s cost.
              </div>
            )}

            {openId === s.id && form && (
              <div className="gatebox" style={{ marginTop: 8 }}>
                <div className="grid3">
                  <div className="fld">
                    <label className="lbl" htmlFor={`sr-printer-${s.id}`}>
                      Machine
                    </label>
                    <select
                      id={`sr-printer-${s.id}`}
                      value={form.printerId}
                      onChange={(e) => setForm((f) => f && { ...f, printerId: e.target.value })}
                    >
                      <option value="">Pick one</option>
                      {ctx.printers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="fld">
                    <label className="lbl" htmlFor={`sr-material-${s.id}`}>
                      Material
                    </label>
                    <select
                      id={`sr-material-${s.id}`}
                      value={form.materialId ?? ''}
                      onChange={(e) =>
                        setForm((f) => f && { ...f, materialId: e.target.value || null })
                      }
                    >
                      <option value="">Not recorded</option>
                      {ctx.materials.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="fld">
                    <label className="lbl" htmlFor={`sr-when-${s.id}`}>
                      Started
                    </label>
                    <input
                      id={`sr-when-${s.id}`}
                      type="date"
                      value={form.startedAt ?? ''}
                      onChange={(e) =>
                        setForm((f) => f && { ...f, startedAt: e.target.value || null })
                      }
                    />
                  </div>
                </div>
                <div className="grid3">
                  <div className="fld">
                    <label className="lbl" htmlFor={`sr-units-${s.id}`}>
                      {unit} off the spool
                    </label>
                    <input
                      id={`sr-units-${s.id}`}
                      type="number"
                      min="0"
                      step="1"
                      value={form.unitsUsed || ''}
                      onChange={(e) =>
                        setForm((f) => f && { ...f, unitsUsed: Number(e.target.value) || 0 })
                      }
                    />
                  </div>
                  <div className="fld">
                    <label className="lbl" htmlFor={`sr-hours-${s.id}`}>
                      Machine hours
                    </label>
                    <input
                      id={`sr-hours-${s.id}`}
                      type="number"
                      min="0"
                      step="0.25"
                      value={form.hours || ''}
                      onChange={(e) =>
                        setForm((f) => f && { ...f, hours: Number(e.target.value) || 0 })
                      }
                    />
                  </div>
                  <div className="fld">
                    <label className="lbl" htmlFor={`sr-outcome-${s.id}`}>
                      How it went
                    </label>
                    <select
                      id={`sr-outcome-${s.id}`}
                      value={form.outcome}
                      onChange={(e) =>
                        setForm((f) => f && { ...f, outcome: e.target.value as RunOutcome })
                      }
                    >
                      <option value="success">Came off clean</option>
                      <option value="failed">Failed</option>
                      <option value="cancelled">Canceled part way</option>
                    </select>
                  </div>
                </div>
                {form.outcome !== 'success' && (
                  <div className="fld">
                    <label className="lbl" htmlFor={`sr-why-${s.id}`}>
                      What went wrong
                    </label>
                    <input
                      id={`sr-why-${s.id}`}
                      value={form.failureReason ?? ''}
                      placeholder="Warped off the plate, clog, power cut…"
                      onChange={(e) =>
                        setForm((f) => f && { ...f, failureReason: e.target.value || null })
                      }
                    />
                  </div>
                )}
                {form.outcome === 'success' && pendingPartsOf(s.id).length > 0 && (
                  <label
                    className="hint"
                    style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}
                  >
                    <input
                      type="checkbox"
                      checked={markParts}
                      onChange={(e) => setMarkParts(e.target.checked)}
                    />
                    Mark the {pendingPartsOf(s.id).length} part
                    {pendingPartsOf(s.id).length === 1 ? '' : 's'} on this plate as printed — one
                    plate is one print, and they all came off together
                  </label>
                )}
                <div className="btnrow" style={{ alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={saving || !form.printerId}
                    onClick={() => void record()}
                  >
                    Record it
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={saving}
                    onClick={() => {
                      setOpenId(null)
                      setForm(null)
                    }}
                  >
                    Cancel
                  </button>
                  <span className="hint" style={{ marginTop: 0 }}>
                    These are the file&rsquo;s numbers — change them to what the machine actually
                    used if you know better. Recording takes the material off the shelf.
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A part's sliced files, one per machine, and which one it is being
 * printed from.
 *
 * The reason this is on the row rather than behind a dialog: the choice
 * changes the TIME, by up to 20% on Voltage's own measurements of the same
 * part sliced for two Bambu machines. Weight barely moves. So a person
 * reading the build sheet to plan a week needs to see, without clicking,
 * whether the hours in front of them belong to the machine the part is
 * actually going on -- and whether anybody chose, or the screen is
 * assuming the fastest.
 */
function PartVariants({
  ctx,
  part,
  busy,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  part: PartRow
  busy: boolean
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const [saving, setSaving] = useState(false)
  if (!part.variants.length) return null

  const { variant, picked } = chosenVariant(part)
  const spread = timeSpreadPct(part)
  const mins = (m: number | null) =>
    m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`

  async function choose(sectionId: string) {
    setSaving(true)
    setError(null)
    try {
      // Pressing the chosen one again clears the choice rather than doing
      // nothing: there has to be a way back to "no decision yet".
      await choosePartVariant(ctx.shop.id, part.id, sectionId === part.chosenSectionId ? null : sectionId)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pvars" style={{ marginTop: 4 }}>
      {part.variants.map((v) => {
        const on = v.sectionId === variant?.sectionId
        return (
          <button
            key={v.sectionId}
            type="button"
            className={`chip ${on ? 'on' : ''}`.trim()}
            disabled={busy || saving}
            title={`${v.fileName} · imported ${v.importedAt.slice(0, 10)}${
              v.estGrams != null ? ` · ~${Math.round(v.estGrams)} g` : ''
            }`}
            onClick={() => void choose(v.sectionId)}
          >
            {v.printerName ?? v.printerModel ?? 'unknown machine'} · {mins(v.estMinutes)}
          </button>
        )
      })}
      {part.variants.length > 1 && !picked && (
        <span className="pmeta" style={{ color: 'var(--warn)' }}>
          assuming the fastest{spread != null && ` — ${spread}% between them`}
        </span>
      )}
      {isOnSharedPlate(variant) && (
        <span className="pmeta">
          shares a plate with {(variant?.plateParts ?? 1) - 1} other object
          {(variant?.plateParts ?? 1) - 1 === 1 ? '' : 's'} — one print, not several
        </span>
      )}
    </div>
  )
}

/**
 * "Start printing by the 17th." The most actionable sentence on the page.
 *
 * A due date is not something you can act on today: everything before the
 * start date is slack and everything after it is a late delivery nobody
 * has noticed yet. This is Voltage's must-start-by, computed from THIS
 * project's own remaining work, with every assumption printed underneath
 * so the date can be argued with rather than believed.
 */
function StartByLine({ detail, locale }: { detail: ProjectDetail; locale: string }) {
  const plan = startBy({
    neededBy: detail.facts.neededBy,
    deliveryHow: detail.facts.deliveryHow,
    parts: detail.parts,
    quote: detail.quoteInputs,
  })

  if (plan.status === 'unknown' || plan.status === 'done' || !plan.date) {
    // Say why there is no date rather than showing nothing: a missing
    // delivery date is a thing the shop can fix in ten seconds.
    if (plan.status === 'unknown' && !detail.facts.neededBy && plan.printHours > 0) {
      return (
        <div className="hint" style={{ marginBottom: 10 }}>
          {Math.round(plan.printHours)} machine hours of work here. Set a delivery date and Guma
          will say when printing has to start.
        </div>
      )
    }
    return null
  }

  const tone = plan.status === 'late' ? 'crit' : plan.status === 'soon' ? 'warn' : ''
  return (
    <div className={`attn ${tone}`.trim()} style={{ marginBottom: 10 }}>
      <b>
        {plan.status === 'late'
          ? `Printing should have started ${Math.abs(plan.daysLeft ?? 0)} day${
              Math.abs(plan.daysLeft ?? 0) === 1 ? '' : 's'
            } ago`
          : `Start printing by ${formatDate(plan.date, locale)}`}
      </b>
      <div style={{ marginTop: 4, fontSize: 12 }}>
        {Math.round(plan.printHours)} machine hours still to print
        {plan.source === 'quote' ? ', estimated from the quote' : ', from the sliced files'} ·{' '}
        {plan.assumptions.join(' · ')}.
      </div>
    </div>
  )
}

/**
 * What a finished project came to, on the project itself.
 *
 * Reported by CG: "the one project I have is at the final phase but I
 * don't see a bunch of useful information there. I don't see the printed
 * file either." He was right -- everything was on the page, spread through
 * five sections each showing the CONTROLS for work that is over. A
 * finished project is not a thing you operate, it is a thing you read, so
 * the end of the ladder gets a summary and the controls stay below it.
 *
 * Nothing here is stored or recalculated: every figure is one the project
 * already derives. The printable one-pager is the same content for
 * somebody outside the shop, and is one click away rather than the only
 * place this existed.
 */
function Closeout({
  detail,
  money,
  locale,
  jobId,
}: {
  detail: ProjectDetail
  money: (n: number) => string
  locale: string
  jobId: string
}) {
  const a = detail.actuals
  const f = detail.facts
  const hours = Math.round((a.machineHours + a.designHours + a.finishingHours + a.adminHours) * 10) / 10
  const days = Math.max(
    0,
    Math.round(
      (new Date(f.deliveryOn ?? detail.updatedAt).getTime() - new Date(detail.createdAt).getTime()) /
        86_400_000,
    ),
  )
  const failed = detail.runs.filter((r) => r.outcome !== 'success').length
  const mins = (m: number | null) =>
    m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`

  return (
    <section className="sec" style={{ marginTop: 18 }}>
      <div className="sechead">
        <h4>{f.kind === 'inhouse' ? 'What this trial came to' : 'What this project came to'}</h4>
        <span className="secstat ok">finished{days ? ` · ${days} days end to end` : ''}</span>
      </div>

      <div className="pane">
        <div className="grid3">
          <Stat
            label={f.kind === 'inhouse' ? 'What it cost you' : 'What it cost to make'}
            value={f.hasActuals ? money(f.actualCost) : 'not recorded'}
            sub={f.hasActuals ? 'material, power, wear and logged hours' : 'no runs or hours were logged'}
            tone={f.hasActuals ? '' : 'crit'}
          />
          {f.kind === 'inhouse' ? (
            <Stat
              label="What it put on the shelf"
              value={f.unitsMade > 0 ? `${f.unitsMade} unit${f.unitsMade === 1 ? '' : 's'}` : 'nothing sellable'}
              sub={f.unitsMade > 0 ? 'costed from this project' : 'recorded as producing no stock'}
            />
          ) : (
            <Stat
              label="What they paid"
              value={f.quoteTotal == null ? '—' : money(f.quoteTotal - f.balanceOwed)}
              sub={f.balanceOwed > 0 ? `${money(f.balanceOwed)} still outstanding` : 'paid in full'}
              tone={f.balanceOwed > 0 ? 'crit' : 'ok'}
            />
          )}
          <Stat
            label="Hours in it"
            value={hours ? `${hours} h` : '—'}
            sub={`${Math.round(a.machineHours * 10) / 10} machine · ${
              Math.round((a.designHours + a.finishingHours + a.adminHours) * 10) / 10
            } yours`}
          />
        </div>

        <div className="grid3" style={{ marginTop: 12 }}>
          <Stat
            label="Material drawn"
            value={a.materialUnits ? `${Math.round(a.materialUnits)}` : '—'}
            sub={a.failedUnits > 0 ? `${Math.round(a.failedUnits)} of it into failed prints` : 'none of it wasted'}
            tone={a.failedUnits > 0 ? 'crit' : ''}
          />
          <Stat
            label="Runs"
            value={a.runs ? `${a.runs}` : 'none recorded'}
            sub={failed > 0 ? `${failed} failed` : a.runs ? 'all came off clean' : 'nothing was logged as printed'}
            tone={failed > 0 ? 'crit' : ''}
          />
          <Stat
            label="Parts"
            value={detail.parts.length ? `${f.partsPassed} of ${f.parts} passed` : 'no build sheet'}
            sub={f.reprintsEver > 0 ? `${f.reprintsEver} sent back along the way` : undefined}
            tone={f.reprintsEver > 0 ? 'crit' : ''}
          />
        </div>
      </div>

      {/* The files it was printed from. The first thing CG went looking
          for and could not find: a finished project that cannot show you
          what it was made from is not a record of anything. */}
      <div className="pane" style={{ marginTop: 10 }}>
        <div className="sechead">
          <h4>Printed from</h4>
          <span className="secstat">
            {detail.slices.length === 0
              ? 'no sliced file was imported'
              : `${detail.slices.length} file${detail.slices.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {detail.slices.length === 0 ? (
          <div className="hint" style={{ marginTop: 0 }}>
            Nothing was imported for this one, so its grams and hours were typed in rather than read
            off a file. Importing the sliced file on the next project is what makes this section
            worth reading.
          </div>
        ) : (
          <div className="sheetwrap" style={{ maxHeight: 'none' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '46%' }}>File</th>
                  <th>Machine</th>
                  <th className="r">Slicer said</th>
                  <th className="r">Actually took</th>
                </tr>
              </thead>
              <tbody>
                {detail.slices.map((sl) => {
                  const runs = detail.runs.filter((r) => r.sliceImportId === sl.id)
                  const used = runs.reduce((x, r) => x + (r.unitsUsed ?? 0), 0)
                  const hrs = runs.reduce((x, r) => x + (r.hours ?? 0), 0)
                  return (
                    <tr key={sl.id}>
                      <td>
                        <span className="pn">{sl.fileName}</span>
                        <div className="pmeta">
                          {sl.sections.length} object{sl.sections.length === 1 ? '' : 's'} ·
                          imported {sl.importedAt.slice(0, 10)}
                        </div>
                      </td>
                      <td>{sl.printerName ?? sl.printerModel ?? '—'}</td>
                      <td className="r mono">
                        {sl.estGrams != null ? `${Math.round(sl.estGrams)} g` : '—'} ·{' '}
                        {mins(sl.estMinutes)}
                      </td>
                      <td className="r mono">
                        {runs.length === 0 ? (
                          <span style={{ color: 'var(--warn)' }}>never recorded</span>
                        ) : (
                          `${Math.round(used)} g · ${Math.round(hrs * 10) / 10} h`
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="btnrow" style={{ marginTop: 10, alignItems: 'center' }}>
        <Link
          to={`/project/${jobId}/closeout`}
          className="btn sm"
          style={{ textDecoration: 'none' }}
        >
          Printable one-pager
        </Link>
        <span className="hint" style={{ marginTop: 0 }}>
          {f.deliveryOn
            ? `Handed over ${formatDate(f.deliveryOn, locale)}${f.deliveryHow ? ` · ${f.deliveryHow}` : ''}.`
            : 'No handover date was recorded.'}{' '}
          Everything below is still here — it is just no longer the point.
        </span>
      </div>
    </section>
  )
}

/**
 * The program this project belongs to, and the one it runs.
 *
 * CG: "BathyTopo be the master program and then I can create sub programs
 * for the Hawaiian Islands, Fiji, French Polynesia, etc... linking old and
 * new programs under one." So this does three jobs, in the order a person
 * needs them:
 *
 *   1. WHERE AM I -- the path above this project, each step a link.
 *   2. WHAT IS IN HERE -- every project under this one, with what each has
 *      cost and made, and one total for the whole program. The totals ADD;
 *      nothing is copied between members, so an hour logged on BathyTopo
 *      is counted once, on BathyTopo.
 *   3. CHANGE IT -- start a sub-project already filed under this one, move
 *      this project under another, or take it out.
 *
 * The tree is rebuilt from the project list every time (lib/programs.ts),
 * so it cannot go stale and needs nothing from either backend beyond one
 * column.
 */
function Program({
  ctx,
  detail,
  rows,
  busy,
  open,
  onToggle,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  rows: JobListRow[] | null
  busy: boolean
  open: boolean
  onToggle: (open: boolean) => void
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [moving, setMoving] = useState(false)
  const [filter, setFilter] = useState('')

  if (!rows) return null
  const id = detail.jobId
  const kids = childrenOf(rows, id)
  const inside = descendantsOf(rows, id)
  const path = ancestorsOf(rows, id)
  const parent = path[path.length - 1] ?? null
  const total = programTotals(rows, id)
  const g = (n: number) => `${Math.round(n)} g`
  const h = (n: number) => `${Math.round(n * 10) / 10} h`
  const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)

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

  async function startSub() {
    const title = newTitle.trim()
    if (!title) return
    setSaving(true)
    setError(null)
    try {
      const newId = await createInHouseJob(ctx.shop.id, { title, relatedTo: id })
      setNewTitle('')
      navigate(`/project/${newId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const options = eligibleParents(rows, id).filter((r) =>
    filter.trim()
      ? `${r.title} ${r.ref} ${pathLabel(rows, r.jobId) ?? ''}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase())
      : true,
  )

  return (
    <details
      className="sec fold"
      data-fold="program"
      style={{ marginTop: 18 }}
      open={open}
      onToggle={(e) => onToggle(e.currentTarget.open)}
    >
      <summary className="sechead">
        <h4>Program</h4>
        <span className="secstat">
          {inside.length
            ? `${inside.length} project${inside.length === 1 ? '' : 's'} inside`
            : parent
              ? `inside ${parent.title}`
              : 'stands alone'}
        </span>
      </summary>

      {inside.length > 0 && (
        <div className="pane">
          <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
            The whole program — this project and everything under it, added up. Each project keeps
            its own figures; nothing is copied or counted twice.
          </div>
          <div className="dtiles" style={{ margin: 0 }}>
            <div className="dtile biolum">
              <span className="dt-lab">Projects</span>
              <span className="dt-v">{total.projects}</span>
              <span className="dt-sub">{total.done} finished</span>
            </div>
            <div className="dtile ember">
              <span className="dt-lab">Cost so far</span>
              <span className="dt-v">{money(total.cost)}</span>
              <span className="dt-sub">material, machine, wear, power, hours</span>
            </div>
            <div className="dtile teal">
              <span className="dt-lab">Printed</span>
              <span className="dt-v">{g(total.materialUnits)}</span>
              <span className="dt-sub">
                {total.runs} run{total.runs === 1 ? '' : 's'} · {h(total.machineHours)} machine
                {total.failedUnits > 0 ? ` · ${g(total.failedUnits)} failed` : ''}
              </span>
            </div>
            <div className="dtile violet">
              <span className="dt-lab">Your time</span>
              <span className="dt-v">{h(total.hours)}</span>
              <span className="dt-sub">design, finishing and admin</span>
            </div>
          </div>
        </div>
      )}

      {kids.length > 0 && (
        <div className="sheetwrap" style={{ maxHeight: 'none', marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: '38%' }}>Inside this program</th>
                <th>Stage</th>
                <th className="r">Printed</th>
                <th className="r">Machine</th>
                <th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {kids.map((k) => {
                const t = programTotals(rows, k.jobId)
                const deeper = t.projects - 1
                return (
                  <tr key={k.jobId}>
                    <td>
                      <Link to={`/project/${k.jobId}`} className="pn" style={{ textDecoration: 'none' }}>
                        {k.title}
                      </Link>
                      <div className="pmeta">
                        {k.ref}
                        {deeper > 0 && ` · ${deeper} inside, included`}
                      </div>
                    </td>
                    <td>
                      <span className="chip">{phaseLabel(k.phase, k.facts.kind)}</span>
                    </td>
                    <td className="r mono">{t.materialUnits ? g(t.materialUnits) : '—'}</td>
                    <td className="r mono">{t.machineHours ? h(t.machineHours) : '—'}</td>
                    <td className="r mono">{t.cost ? money(t.cost) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Start a sub-project already filed here. Creating a project and
          then hunting for it to link was the long way round, and it is how
          the drafts confusion started. */}
      <div className="btnrow" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220 }}>
          <label className="lbl" htmlFor="sub-title">
            Start a project inside {detail.title}
          </label>
          <input
            id="sub-title"
            value={newTitle}
            placeholder="Fiji, French Polynesia, Oʻahu…"
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void startSub()
            }}
          />
        </div>
        <button
          type="button"
          className="btn sm primary"
          disabled={busy || saving || !newTitle.trim()}
          onClick={() => void startSub()}
        >
          Start it
        </button>
      </div>

      <div className="btnrow" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn sm"
          disabled={busy || saving}
          onClick={() => setMoving((v) => !v)}
        >
          {parent ? 'Move to another program' : 'Put this inside a program'}
        </button>
        {parent && (
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy || saving}
            onClick={() => void guard(() => setRelatedProject(ctx.shop.id, id, null))}
          >
            Take it out of {parent.title}
          </button>
        )}
      </div>

      {moving && (
        <div className="pane" style={{ marginTop: 10 }}>
          <div className="fld" style={{ marginTop: 0 }}>
            <label className="lbl" htmlFor="move-find">
              Which program? Anything already inside this one is left out — that would be a loop.
            </label>
            <input
              id="move-find"
              value={filter}
              placeholder="Find by name or reference"
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {options.length === 0 ? (
            <div className="hint">Nothing matches.</div>
          ) : (
            <div className="stack" style={{ maxHeight: 280, overflow: 'auto' }}>
              {options.slice(0, 40).map((o) => {
                const where = pathLabel(rows, o.jobId)
                return (
                  <button
                    key={o.jobId}
                    type="button"
                    className="btn sm"
                    disabled={saving || o.jobId === parent?.jobId}
                    style={{ justifyContent: 'space-between', gap: 10 }}
                    onClick={() =>
                      void guard(async () => {
                        await setRelatedProject(ctx.shop.id, id, o.jobId)
                        setMoving(false)
                        setFilter('')
                      })
                    }
                  >
                    <span style={{ textAlign: 'left' }}>
                      {where ? <span style={{ color: 'var(--txt-3)' }}>{where} › </span> : null}
                      {o.title}
                    </span>
                    <span className="chip">
                      {o.facts.takenInAt || o.facts.kind === 'inhouse'
                        ? phaseLabel(o.phase, o.facts.kind)
                        : 'Draft'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </details>
  )
}

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
  /**
   * How many rows arrived from the last import, so the build sheet can say
   * which ones they are. Counted rather than keyed by id because the parts
   * are re-fetched after the import and the new ones sort last -- and a
   * count is enough for one pass of colour that then goes away forever.
   */
  const [landed, setLanded] = useState(0)
  const markLanded = (n: number) => {
    setLanded(n)
    // One pass, then an ordinary row. A highlight that persists becomes
    // another thing on screen that means nothing.
    window.setTimeout(() => setLanded(0), 2200)
  }
  const [reprintFor, setReprintFor] = useState<string | null>(null)
  // A part's history drawer changes the height of the build sheet above
  // whatever you click next. See rowAnchor.ts.
  const holdRow = useRowAnchor(openId)
  const [why, setWhy] = useState('')
  const [fix, setFix] = useState('')
  const [fixedFile, setFixedFile] = useState<File | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const tally = failureTally(detail.parts, detail.runs)

  /**
   * Send a part back, Voltage's way: why it failed, how to make the next
   * attempt work, and -- when the fix was a re-slice -- the fixed file
   * itself. The file goes through the same import as any other, so it
   * updates this part's estimate rather than adding a duplicate row, is
   * kept with the project, and waits under "Sliced files" to be recorded
   * when the reprint comes off the bed.
   */
  async function sendBack(part: PartRow) {
    let fileName: string | null = null
    if (fixedFile) {
      const parsed = await parseSliceFile(fixedFile)
      const bytes = new Uint8Array(await fixedFile.arrayBuffer())
      await importSlice(ctx.shop.id, detail.jobId, ctx.profile.id, {
        file: await packFile(bytes),
        fileName: parsed.fileName,
        kind: parsed.kind,
        printerModel: parsed.printerModel,
        printerId: matchPrinter(ctx.printerRows, parsed.printerModel)?.id ?? null,
        materialText: parsed.totals.material,
        materialId: matchMaterial(ctx.materials, parsed.totals.material)?.id ?? null,
        estMinutes: parsed.totals.estMinutes,
        estGrams: parsed.totals.estGrams,
        notes: parsed.notes,
        sections: parsed.sections.map((sec) => ({
          label: sec.label,
          qty: sec.qty,
          estMinutes: sec.estMinutes,
          estGrams: sec.estGrams,
          material: sec.material,
        })),
      })
      fileName = parsed.fileName
    }
    await setPartStatus(ctx.shop.id, part.id, ctx.profile.id, 'reprint', reprintNote(why, fix, fileName))
    setReprintFor(null)
    setFixedFile(null)
  }

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
      setFix('')
      setFixedFile(null)
      return
    }
    await guard(() => setPartStatus(ctx.shop.id, part.id, ctx.profile.id, status, null))
  }

  return (
    <div className="pane" style={{ marginBottom: 0 }}>
      {/* The import comes FIRST.
          It used to sit at the very bottom, under the empty-state paragraph
          and the manual Part/Copies row, which meant the fastest way to fill
          a build sheet was the last thing you saw and looked like a
          footnote. Reported as "I uploaded a gcode and nothing happened".
          Reading a file is the primary action here; typing parts by hand is
          the fallback, and is now ordered that way. */}
      {/* Import is open at every stage. It was hidden from Review on, so a
          finished project -- Maui -- had nowhere to put the file that made it. */}
      {(
        <SliceImport
          ctx={ctx}
          detail={detail}
          busy={busy || saving}
          onChanged={onChanged}
          onImported={markLanded}
          setError={setError}
        />
      )}

      {/* A QC failure means the project is not in review any anymore --
          something has to go back on a machine. Voltage offered the move
          rather than making it, because three other parts may still be
          being checked, and that is the behaviour kept here. */}
      {shouldReturnToBuilding(detail.phase, detail.parts) && (
        <div className="attn warn" style={{ marginBottom: 10 }}>
          <b>A part was sent back.</b>
          <div style={{ marginTop: 4, fontSize: 12 }}>
            {detail.parts.filter((p) => p.status === 'reprint').length} part
            {detail.parts.filter((p) => p.status === 'reprint').length === 1 ? '' : 's'} need
            reprinting, which is building work, not checking work. Move the project back and the
            reasons travel with the parts.
          </div>
          <button
            type="button"
            className="btn sm primary"
            style={{ marginTop: 8 }}
            disabled={busy || saving}
            onClick={() =>
              void guard(() =>
                updateJobPhase(
                  ctx.shop.id,
                  detail.jobId,
                  ctx.profile.id,
                  buildingPhase(detail.facts.kind),
                ),
              )
            }
          >
            Put it back in building
          </button>
        </div>
      )}

      <SliceRuns
        ctx={ctx}
        detail={detail}
        busy={busy || saving}
        onChanged={onChanged}
        setError={setError}
      />

      {tally && (
        <div
          className="hint"
          role="note"
          aria-label="Failures on this project"
          style={{ marginTop: 12, color: 'var(--red)' }}
        >
          Failures so far:{' '}
          {[
            tally.sentBack > 0 &&
              `${tally.sentBack} send-back${tally.sentBack === 1 ? '' : 's'} across ${tally.partsAffected} part${tally.partsAffected === 1 ? '' : 's'}`,
            tally.failedRuns > 0 &&
              `${tally.failedRuns} failed plate${tally.failedRuns === 1 ? '' : 's'} (${tally.unitsLost} g, ${tally.hoursLost} h lost)`,
          ]
            .filter(Boolean)
            .join(' · ')}
          {tally.repeatReason && ` · same reason more than once: “${tally.repeatReason}” — likely a design or setup problem, not luck`}
          .
        </div>
      )}

      {detail.parts.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--txt-2)', marginTop: 14 }}>
          Nothing listed yet — import a sliced file above, or add parts by hand below. A build
          sheet is worth keeping when a project is more than one object —
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
              {detail.parts.map((p, i) => (
                <Fragment key={p.id}>
                  <tr className={landed > 0 && i >= detail.parts.length - landed ? 'landed' : ''}>
                    <td>
                      <span className="pn">{p.label}</span>
                      {p.history.length > 1 && (
                        <button
                          type="button"
                          className="linkbtn"
                          style={{ marginLeft: 8, fontSize: 10 }}
                          onClick={(e) => {
                            holdRow(e.currentTarget.closest('tr'))
                            setOpenId(openId === p.id ? null : p.id)
                          }}
                        >
                          history ({p.history.length})
                        </button>
                      )}
                      {p.note && <div className="pmeta">{p.note}</div>}
                      {/* The reason a part is going back belongs HERE, not
                          one click away in its history drawer: whoever
                          prints it next is reading this row, not the
                          drawer. Voltage's rule, and the reason it made
                          reprints stop repeating. */}
                      {reprintReason(p) && (
                        <div className="pmeta" style={{ color: 'var(--red)' }}>
                          ↩ {reprintReason(p)}
                          {reprintCount(p) > 1 && ` · sent back ${reprintCount(p)} times`}
                        </div>
                      )}
                      <PartVariants
                        ctx={ctx}
                        part={p}
                        busy={busy || saving}
                        onChanged={onChanged}
                        setError={setError}
                      />
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
                        {allowedStatuses(detail.phase, detail.facts.kind)
                          .filter((st) => st !== p.status)
                          .map((st) => (
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
                          ))}
                        <button
                          type="button"
                          className="linkbtn"
                          style={{ fontSize: 10 }}
                          disabled={busy || saving}
                          aria-label={`Edit ${p.label}`}
                          onClick={() => setEditId(editId === p.id ? null : p.id)}
                        >
                          edit
                        </button>
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
                  {editId === p.id && (
                    <tr>
                      <td colSpan={4} style={{ background: 'var(--panel-3)' }}>
                        <PartEditor
                          part={p}
                          busy={busy || saving}
                          onCancel={() => setEditId(null)}
                          onSave={(input) =>
                            guard(async () => {
                              await updatePart(ctx.shop.id, p.id, input, ctx.profile.id)
                              setEditId(null)
                            })
                          }
                        />
                      </td>
                    </tr>
                  )}
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
                            placeholder="Layer shift at 40mm, warped corner, wrong color…"
                            onChange={(e) => setWhy(e.target.value)}
                          />
                        </div>
                        <div className="fld" style={{ margin: '6px 0 0' }}>
                          <label className="lbl" htmlFor={`fix-${p.id}`}>
                            How to get it right next time
                          </label>
                          <input
                            id={`fix-${p.id}`}
                            value={fix}
                            placeholder="Brim on, slow first layer to 15mm/s, dry the spool…"
                            onChange={(e) => setFix(e.target.value)}
                          />
                        </div>
                        <div className="fld" style={{ margin: '6px 0 0' }}>
                          <label className="lbl" htmlFor={`fixed-${p.id}`}>
                            Fixed file (optional) — the re-sliced plate for the reprint
                          </label>
                          <input
                            id={`fixed-${p.id}`}
                            type="file"
                            accept={SLICE_ACCEPT}
                            onChange={(e) => setFixedFile(e.target.files?.[0] ?? null)}
                          />
                        </div>
                        <div className="btnrow" style={{ marginTop: 6, alignItems: 'center' }}>
                          <button
                            type="button"
                            className="btn sm primary"
                            disabled={!why.trim() || saving}
                            onClick={() => void guard(() => sendBack(p))}
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
    startedAt: todayISO(),
  })
  const [work, setWork] = useState({
    kind: 'design' as WorkKind,
    hours: '',
    workedOn: todayISO(),
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
                <option value="cancelled">Canceled part way</option>
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
              placeholder="Modeled the mount, third revision, wash and cure…"
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

/**
 * Delete, with the consequences named.
 *
 * Two steps, and the second one counts what is about to go. A project is
 * the parent of its payments, its runs, its logged hours and its build
 * sheet, and all of it cascades — so "are you sure?" is not enough when the
 * honest question is "are you sure about the four payments?".
 *
 * There is no archive and no undo. That is a real choice, not an omission:
 * a soft-delete that hides rows still counts them in every rollup unless
 * every query learns to exclude them, and a half-excluded row in a tool
 * about money is worse than a deliberate deletion.
 */
function DeleteProject({
  detail,
  busy,
  onConfirm,
}: {
  detail: ProjectDetail
  busy: boolean
  onConfirm: () => Promise<void>
}) {
  const [armed, setArmed] = useState(false)
  const goes = [
    detail.payments.length && `${detail.payments.length} payment${detail.payments.length === 1 ? '' : 's'}`,
    detail.runs.length && `${detail.runs.length} build run${detail.runs.length === 1 ? '' : 's'}`,
    detail.work.length && `${detail.work.length} logged entr${detail.work.length === 1 ? 'y' : 'ies'}`,
    detail.parts.length && `${detail.parts.length} part${detail.parts.length === 1 ? '' : 's'}`,
    detail.quote && 'its quote',
  ].filter(Boolean) as string[]

  if (!armed) {
    return (
      <button
        type="button"
        className="btn ghost"
        disabled={busy}
        style={{ color: 'var(--red)' }}
        onClick={() => setArmed(true)}
      >
        Delete
      </button>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: 'var(--red)', maxWidth: '46ch' }}>
        Delete {detail.ref} for good
        {goes.length > 0 ? `, along with ${goes.join(', ')}` : ''}. This cannot be undone.
      </span>
      <button type="button" className="btn sm ghost" onClick={() => setArmed(false)}>
        Keep it
      </button>
      <button
        type="button"
        className="btn sm danger"
        disabled={busy}
        onClick={() => void onConfirm()}
      >
        Delete it
      </button>
    </span>
  )
}

function FlagPanel({
  flags,
  busy,
  onClear,
}: {
  flags: Flag[]
  busy: boolean
  /** Flags a person raised or can settle by hand get a clear button. */
  onClear: (key: Flag['key']) => Promise<void> | undefined
}) {
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
            {f.key === 'over-ceiling' && (
              <button
                type="button"
                className="btn sm"
                style={{ marginTop: 6 }}
                disabled={busy}
                onClick={() => void onClear(f.key)}
              >
                Client agreed — clear this flag
              </button>
            )}
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
  // An unticked item is the only thing on this row that matters, so it is
  // the only thing given weight. Ticked items stay legible and quiet --
  // they are evidence, not a to-do list.
  const todo = !item.checked
  return (
    <div className={`gwrap ${todo ? 'todo' : ''}`}>
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
          {todo && (
            <span className="todo-chip">{item.automatic ? 'waiting on' : 'to do'}</span>
          )}
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

/**
 * What this job actually produced.
 *
 * Only on in-house work, because that is the only kind where the answer is
 * units on a shelf rather than a delivery to somebody. A shop that prints
 * two hundred keychains has turned a job's cost into stock, and until this
 * existed the cost was recorded and the stock was not, so the job read as
 * pure expense forever.
 *
 * The unit cost is frozen here, from what the job actually recorded --
 * material at what the shop paid, machine, wear and the hands-on hours --
 * divided by the units made. Design hours are deliberately left OUT and
 * carried on the product instead. Design in both places would tell the shop
 * the thing costs more than it does AND that it has recovered less than it
 * has. See splitJobCost.
 */
function MadeSection({
  ctx,
  detail,
  money,
  onSaved,
  setError,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  money: (n: number) => string
  onSaved: () => void
  setError: (m: string | null) => void
}) {
  const navigate = useNavigate()
  const [products, setProducts] = useState<ProductRow[]>([])
  const [productId, setProductId] = useState('')
  const [name, setName] = useState('')
  const [units, setUnits] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void listShelf(ctx.shop.id)
      .then((rows) => {
        if (!cancelled) setProducts(rows.filter((p) => !p.archived))
      })
      .catch(() => {
        // The shelf being unreadable must not take the project page down
        // with it. The form still works; it just cannot offer existing
        // products to add to.
      })
    return () => {
      cancelled = true
    }
  }, [ctx.shop.id])

  /** Batches already recorded against THIS job, so the section says what it
   *  has done rather than offering to do it again from scratch. */
  const already = useMemo(
    () =>
      products.flatMap((p) =>
        p.batches.filter((b) => b.job_id === detail.jobId).map((b) => ({ product: p, batch: b })),
      ),
    [products, detail.jobId],
  )

  const split = splitJobCost(
    { actualCost: detail.facts.actualCost, designHours: detail.actuals.designHours },
    Number(ctx.rateCard.design_hourly),
  )
  const n = Number(units) || 0
  const unitCost = unitCostFrom(split, n)
  const isNew = productId === ''

  async function record() {
    setBusy(true)
    setError(null)
    try {
      const id = isNew
        ? await saveProduct(ctx.shop.id, {
            name,
            designJobId: detail.jobId,
            // The design investment, recorded once, on the product. Null
            // rather than zero when nothing was logged: "not tracked" and
            // "free" are different answers and the payback says so.
            designCost: split.design > 0 ? split.design : null,
            designHours: detail.actuals.designHours > 0 ? detail.actuals.designHours : null,
          })
        : productId
      await saveBatch(ctx.shop.id, {
        productId: id,
        jobId: detail.jobId,
        unitsMade: n,
        unitCost,
        madeOn: todayISO(),
      })
      setUnits('')
      setName('')
      onSaved()
      navigate('/shelf')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="sec">
      <div className="sechead">
        <h4>What this made</h4>
        <span className="secstat">
          {already.length > 0
            ? `${already.reduce((t, a) => t + Number(a.batch.units_made), 0)} on the shelf`
            : detail.facts.hasActuals
              ? `${money(split.production)} of production recorded`
              : 'nothing recorded yet'}
        </span>
      </div>
      <div className="pane" style={{ marginBottom: 0 }}>
        {already.length > 0 && (
          <div className="guide" style={{ marginTop: 0, marginBottom: 12 }}>
            {already.map(({ product, batch }) => (
              <div className="guide-g" key={batch.id}>
                <div className="guide-h">
                  <span className="guide-tag alt">Recorded</span>
                  <Link to="/shelf" className="addnote" style={{ marginLeft: 'auto' }}>
                    on the shelf
                  </Link>
                </div>
                <div className="guide-kv">
                  <div className="guide-r">
                    <span className="k">
                      {batch.units_made} × {product.name}
                    </span>
                    <span className="v">{money(Number(batch.unit_cost))} each</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!detail.facts.hasActuals ? (
          <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
            Log the runs and hours above first. The cost of what this made comes from what was
            actually recorded, not from a number typed here.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--txt-2)', marginBottom: 10 }}>
              This job spent real money. If it produced units you can sell, record them and the cost
              follows them onto the shelf instead of sitting here as pure expense.
            </div>
            <div className="grid3">
              <div className="fld">
                <label className="lbl" htmlFor="md-product">What did it make</label>
                <select
                  id="md-product"
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                >
                  <option value="">Something new</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              {isNew && (
                <div className="fld">
                  <label className="lbl" htmlFor="md-name">Call it</label>
                  <input
                    id="md-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Hex keychain"
                  />
                </div>
              )}
              <div className="fld">
                <label className="lbl" htmlFor="md-units">How many usable units</label>
                <input
                  id="md-units"
                  type="number"
                  min="1"
                  step="1"
                  value={units}
                  onChange={(e) => setUnits(e.target.value)}
                />
                <div className="hint">Failed prints stay a cost. Only count what you can sell.</div>
              </div>
            </div>

            {n > 0 && (
              <div className="guide" style={{ marginTop: 10 }}>
                <div className="guide-g">
                  <div className="guide-h"><span className="guide-tag">Yours</span></div>
                  <div className="guide-kv">
                    <div className="guide-r">
                      <span className="k">Production recorded on this job</span>
                      <span className="v">{money(split.production)}</span>
                    </div>
                    <div className="guide-r">
                      <span className="k">Each one cost you</span>
                      <span className="v">{money(unitCost)}</span>
                    </div>
                    {split.design > 0 && (
                      <div className="guide-r">
                        <span className="k">
                          Design, {detail.actuals.designHours} h — carried on the product
                        </span>
                        <span className="v">{money(split.design)}</span>
                      </div>
                    )}
                  </div>
                  <div className="guide-note">
                    Frozen at today. Filament costing what it costs now is what these units cost,
                    whatever a spool costs next year.
                    {split.design > 0 &&
                      ' Design is kept off the unit cost and reported as a payback instead, so making more of them never rewrites what the first batch cost.'}
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy || n < 1 || (isNew && !name.trim())}
                onClick={record}
              >
                {busy ? 'Saving…' : 'Put them on the shelf'}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/**
 * The project's name, renamable from the header at any stage.
 *
 * It used to be editable only inside "The brief", which is folded shut on a
 * delivered project -- so a finished project looked impossible to rename.
 * Every rename is logged to Activity by the data layer.
 */
function TitleEditor({
  title,
  busy,
  onSave,
}: {
  title: string
  busy: boolean
  onSave: (title: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  if (!editing) {
    return (
      <h3 style={{ fontSize: 18 }}>
        {title}{' '}
        <button
          type="button"
          className="linkbtn"
          style={{ fontSize: 11, fontWeight: 400 }}
          aria-label="Rename project"
          onClick={() => {
            setDraft(title)
            setEditing(true)
          }}
        >
          rename
        </button>
      </h3>
    )
  }
  const save = async () => {
    const v = draft.trim()
    if (v && v !== title) await onSave(v)
    setEditing(false)
  }
  return (
    <form
      style={{ display: 'flex', gap: 6, alignItems: 'center' }}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <input
        aria-label="Project name"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false)
        }}
        style={{ fontSize: 16, minWidth: 260 }}
      />
      <button type="submit" className="btn sm" disabled={busy || !draft.trim()}>
        Save name
      </button>
      <button type="button" className="btn sm ghost" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  )
}

/** Rename a part, change its copies or its note. Logged to the part's own
 *  history and to the project's Activity. */
function PartEditor({
  part,
  busy,
  onSave,
  onCancel,
}: {
  part: PartRow
  busy: boolean
  onSave: (input: { label: string; qty: number; note: string | null }) => Promise<void>
  onCancel: () => void
}) {
  const [label, setLabel] = useState(part.label)
  const [qty, setQty] = useState(String(part.qty))
  const [note, setNote] = useState(part.note ?? '')
  return (
    <form
      style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
      onSubmit={(e) => {
        e.preventDefault()
        void onSave({ label, qty: Number(qty), note: note.trim() || null })
      }}
    >
      <div className="fld" style={{ margin: 0, flex: 2 }}>
        <label className="lbl" htmlFor={`pe-label-${part.id}`}>
          Part name
        </label>
        <input id={`pe-label-${part.id}`} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="fld" style={{ margin: 0, width: 80 }}>
        <label className="lbl" htmlFor={`pe-qty-${part.id}`}>
          Copies
        </label>
        <input
          id={`pe-qty-${part.id}`}
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
      </div>
      <div className="fld" style={{ margin: 0, flex: 3 }}>
        <label className="lbl" htmlFor={`pe-note-${part.id}`}>
          Note
        </label>
        <input id={`pe-note-${part.id}`} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button type="submit" className="btn sm" disabled={busy || !label.trim()}>
        Save part
      </button>
      <button type="button" className="btn sm ghost" onClick={onCancel}>
        Cancel
      </button>
    </form>
  )
}

/**
 * The sliced files, inside "What it actually took" -- where CG looked for
 * them. Each distinct file with what the slicer said and what has been
 * recorded; one click turns a file's numbers into the run (hours on the
 * machine, filament off the shelf, the plate's parts marked printed).
 * Recording is still a person's click -- an estimate is not an actual --
 * but it is one click, here, not a form under a folded build sheet.
 */
function FromTheFiles({
  ctx,
  detail,
  busy,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  busy: boolean
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const groups = groupSliceFiles(detail.slices, detail.runs)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  if (groups.length === 0) return null

  const hrs = (h: number | null) => (h == null ? '—' : `${h} h`)
  const machineOf = (g: FileGroup) => picked[g.first.id] || machineFor(g, ctx.printers)
  const waiting = groups.filter((g) => !g.recorded)
  const ready = waiting.filter((g) => machineOf(g))

  async function recordOne(g: FileGroup) {
    const printerId = machineOf(g)
    if (!printerId) return
    await recordPrintRun(ctx.shop.id, detail.jobId, ctx.profile.id, {
      printerId,
      materialId: g.first.materialId,
      unitsUsed: g.first.materialId ? (g.estGrams ?? 0) : 0,
      hours: g.estHours ?? 0,
      outcome: 'success',
      failureReason: null,
      note: `From ${g.first.fileName}`,
      // The day the file arrived is the closest thing to a print date the
      // record has; it is shown, and editable on the run afterwards.
      startedAt: g.first.importedAt.slice(0, 10),
      sliceImportId: g.first.id,
    })
    if (allowedStatuses(detail.phase, detail.facts.kind).includes('printed')) {
      const partIds = new Set(
        detail.slices.filter((s) => g.ids.includes(s.id)).flatMap((s) => s.sections.map((x) => x.partId)),
      )
      for (const p of detail.parts) {
        if (partIds.has(p.id) && p.status === 'pending') {
          await setPartStatus(ctx.shop.id, p.id, ctx.profile.id, 'printed', null)
        }
      }
    }
  }

  async function run(list: FileGroup[]) {
    setSaving(true)
    setError(null)
    try {
      for (const g of list) await recordOne(g)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const recordedHours = groups.reduce((a, g) => a + g.usedHours, 0)
  const recordedUnits = groups.reduce((a, g) => a + g.usedUnits, 0)

  return (
    <div style={{ marginTop: 12 }} aria-label="From the sliced files" role="region">
      <div className="sechead">
        <h4>From the sliced files</h4>
        <span className="sub">
          {Math.round(recordedHours * 100) / 100} machine h · {recordedUnits} g recorded from{' '}
          {groups.length - waiting.length} of {groups.length} file{groups.length === 1 ? '' : 's'}
        </span>
      </div>
      {waiting.length > 0 && (
        <div className="attn warn" style={{ marginBottom: 8 }}>
          <span>
            {waiting.length === 1 ? 'One file has' : `${waiting.length} files have`} numbers that are
            not in this project&rsquo;s cost yet. If it printed, record it — the hours go on the
            machine and the filament comes off the shelf.
          </span>
          {ready.length > 1 && (
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || saving}
              onClick={() => void run(ready)}
            >
              Record all {ready.length} from the files
            </button>
          )}
        </div>
      )}
      <div className="sheetwrap" style={{ maxHeight: 'none' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: '38%' }}>File</th>
              <th>Machine</th>
              <th className="r">Slicer said</th>
              <th className="r">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const machine = machineOf(g)
              return (
                <tr key={g.first.id}>
                  <td>
                    <span className="pn">{g.first.fileName}</span>
                    {g.uploads > 1 && (
                      <div className="pmeta">uploaded {g.uploads} times — counted once</div>
                    )}
                  </td>
                  <td>
                    {g.recorded || machine ? (
                      <span style={{ fontSize: 12 }}>
                        {ctx.printers.find((p) => p.id === (g.runs[0]?.printerId ?? machine))?.name ??
                          g.first.printerName ??
                          g.first.printerModel ??
                          '—'}
                      </span>
                    ) : (
                      <select
                        aria-label={`Machine for ${g.first.fileName}`}
                        value={picked[g.first.id] ?? ''}
                        onChange={(e) => setPicked((m) => ({ ...m, [g.first.id]: e.target.value }))}
                      >
                        <option value="">
                          Pick the machine{g.first.printerModel ? ` (file says ${g.first.printerModel})` : ''}
                        </option>
                        {ctx.printers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="r mono">
                    {g.estGrams != null ? `${g.estGrams} g` : '—'} · {hrs(g.estHours)}
                  </td>
                  <td className="r">
                    {g.recorded ? (
                      <span className="mono" style={{ color: 'var(--ok)' }}>
                        ✓ {g.usedUnits} g · {g.usedHours} h
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn sm primary"
                        disabled={busy || saving || !machine}
                        title={machine ? undefined : 'Pick the machine it printed on first.'}
                        aria-label={`Record ${g.first.fileName} from the file`}
                        onClick={() => void run([g])}
                      >
                        Record it
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Move a project back to an earlier stage. A reason is required: going
 *  backwards is information -- what broke, what is being redone -- and the
 *  next person reading Activity needs it. */
function MoveBack({
  to,
  busy,
  onMove,
}: {
  to: string
  busy: boolean
  onMove: (why: string) => Promise<void>
}) {
  const [why, setWhy] = useState('')
  return (
    <div className="gatebox" style={{ marginBottom: 8 }}>
      <div className="fld" style={{ margin: 0 }}>
        <label className="lbl" htmlFor="move-back-why">
          Move this project back to {to} — what needs fixing?
        </label>
        <input
          id="move-back-why"
          value={why}
          placeholder="Coastline off by a layer, client wants a change, failed QC…"
          onChange={(e) => setWhy(e.target.value)}
        />
      </div>
      <div className="btnrow" style={{ marginTop: 6 }}>
        <button
          type="button"
          className="btn sm"
          disabled={busy || !why.trim()}
          onClick={() => void onMove(why)}
        >
          Move back to {to}
        </button>
      </div>
    </div>
  )
}
