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
  listSliceImports,
  listMadeItems,
  recordMadeItems,
  placeItems,
  listAssemblies,
  saveAssembly,
  finishAssembly,
  deleteAssembly,
  deleteSliceImport,
  sliceFileContent,
  archiveProject,
  setRelatedProject,
  listJobs,
  listSeries,
  setJobSeries,
  type SeriesRow,
  type JobListRow,
  deletePart,
  updatePart,
  choosePartVariant,
  movePartCopies,
  requeueCopyFromFile,
  setCopyStates,
  setPartsCopies,
  setSliceProgress,
  setSliceExtras,
  skipCopy,
  markPlateFailed,
  markPlatePrinted,
  markPlateParts,
  correctPrintRun,
  deletePrintRun,
  moveSliceSection,
  deleteWorkEntry,
  loadProjectDetail,
  listMaterials,
  listStockHolds,
  setStockHolds,
  logWork,
  recordPrintRun,
  setQuoteStatus,
  takeProjectIn,
  deleteProject,
  recordPayment,
  setGateItem,
  skipGateItem,
  updateJobPhase,
  updateProjectFields,
  listShelf,
  type ProductRow,
  type PaymentInput,
  type PaymentKind,
  type PaymentMethod,
  type PartRow,
  type PartStatus,
  type PrintRunInput,
  type ProjectDetail,
  type ProjectActuals,
  type MaterialRow,
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
  awaitingPrint,
  buildingPhase,
  chosenVariant,
  isOnSharedPlate,
  reprintCount,
  reprintNote,
  reprintReason,
  shouldReturnToBuilding,
  timeSpreadPct,
} from '../lib/parts'
import { makeMoney } from '../lib/pricing'
import { todayISO, formatDate } from '../lib/dates'
import { groupSliceFiles, newestFirst, machineFor, type FileGroup } from '../lib/fromFiles'
import { seriesAncestors, seriesPath } from '../lib/series'
import {
  canImport,
  canPrint,
  hoursKind,
  moneyMode,
  recordFor,
  stagesBehind,
  workFor,
  type Section,
} from '../lib/stagePlan'
import { startBy } from '../lib/schedule'
import { defaultOpen, readFolds, writeFolds, type FoldScope } from '../lib/folds'
import {
  ancestorsOf,
  childrenOf,
  descendantsOf,
  programTotals,
} from '../lib/programs'
import { buildComparison, compareToQuote, priceProjectQuote, type Comparison } from '../lib/actuals'
import type { PricedQuote, RateSet } from '../lib/pricing'
import { sheetVsQuote } from '../lib/sheetVsQuote'
import HoursInput from '../components/HoursInput'
import { fmtHours } from '../lib/duration'
import { fmtMinutes, progressAt, type ProgressPoint } from '../lib/gcodeWalk'
import { sameSliceFile, uniqueLabel, type PrintRunRow, type SliceImportRow, type StockHoldRow } from '../lib/data.types'
import { splitJobCost } from '../lib/selling'
import { fileExtras, type FileExtras } from '../lib/fileExtras'
import { gramsUsed, plateObjects, runCost, splitCost, assemblyStatus, type ObjectResult, type PlateObject } from '../lib/madeItems'
import type { MadeItemRow, AssemblyRow, MadeItemInput } from '../lib/data.types'
import { plateRemoval, strandedReport } from '../lib/plateRemoval'
import { choiceFrom, choiceValue, guessSort, nameFromFile, partSizes, perCopyOf, toAssign, type BatchPart, type SortChoice, type SortGuess } from '../lib/sortParts'
import { materialCheck, trimHolds } from '../lib/scheduleCheck'
import AddStock from '../components/AddStock'
import { changeCopies, copiesOf, describeCopies, movable, statesOf } from '../lib/copies'

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
  const [backOpen, setBackOpen] = useState(false)
  // Finished projects open differently from live ones: a delivered project
  // is a record behind a summary, not a control panel.
  const fold = useFolds(detail?.phase === 'delivered' ? 'done' : 'live')

  const rates = useMemo(() => toRateSet(ctx.rateCard, ctx.shop), [ctx.rateCard, ctx.shop])
  const { money } = useMemo(() => makeMoney(rates.currency, rates.locale), [rates])

  /** Every project, for the program tree -- the path above this one and
   *  everything under it. See lib/programs.ts. */
  const [allRows, setAllRows] = useState<JobListRow[] | null>(null)
  const [allSeries, setAllSeries] = useState<SeriesRow[]>([])
  /** Stock on hand, for Scheduled's material check. */
  const [stock, setStock] = useState<MaterialRow[]>([])
  const [holds, setHolds] = useState<StockHoldRow[]>([])

  const reload = useCallback(async () => {
    try {
      const [d, rows, series, mats, held] = await Promise.all([
        loadProjectDetail(ctx.shop.id, jobId),
        listJobs(ctx.shop.id),
        listSeries(ctx.shop.id),
        listMaterials(ctx.shop.id),
        listStockHolds(ctx.shop.id),
      ])
      setStock(mats)
      setHolds(held)
      setDetail(d)
      setAllRows(rows)
      setAllSeries(series)
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
  // The Scheduled checks need the build sheet, stock and the start-by
  // date, which only this page loads -- so they are made here and handed
  // to the gate as facts (see ProjectFacts.schedule).
  const plan = schedulePlan(detail, stock, rates.failurePct, holds)
  // Enough material means covered AND set aside: covered alone is a
  // reading the next project can take the same grams from.
  const materialOk = plan.material.ok === null ? null : plan.material.ok && plan.material.allSetAside
  const facts = { ...detail.facts, schedule: { materialOk, slotOk: plan.slotOk } }
  const mySeriesId = allRows?.find((r) => r.jobId === detail.jobId)?.facts.seriesId ?? null
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

  /** Skip a gate item on purpose with a reason, or take the skip back. */
  async function skipItem(item: ResolvedGateItem, reason: string | null) {
    try {
      await skipGateItem(jobId, ctx.profile.id, shown, item.key, item.label, reason)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Client approval, moved past without the yes or the deposit (CG, 7 Oct).
   * One written reason covers both, goes on each skipped item and in
   * Activity, and the board keeps showing the money as a decision rather
   * than dropping it. Anything else still open -- an unsent quote, an
   * uncommitted date -- still blocks: this is about money, not a bypass.
   */
  async function goAheadWithout(why: string) {
    const reason = why.trim()
    if (!reason || !detail || shown !== 'approval' || detail.phase !== 'approval') return
    const money = gate.items.filter((i) => GO_AHEAD_KEYS.includes(i.key) && !i.checked)
    const rest = gate.items.filter((i) => !GO_AHEAD_KEYS.includes(i.key) && !i.checked)
    setBusy(true)
    try {
      for (const i of money) {
        await skipGateItem(jobId, ctx.profile.id, 'approval', i.key, i.label, reason)
      }
      if (rest.length === 0 && gate.next) {
        const what = money.map((i) => (i.key === 'accepted' ? 'acceptance' : 'deposit')).join(' or ')
        await updateJobPhase(
          ctx.shop.id, jobId, ctx.profile.id, gate.next,
          `Went ahead without ${what}. Why: ${reason}`,
        )
        setViewPhase(null)
      }
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
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


  /* ---- sections: each one is either this stage's work or history ---- */
  // `inRecord` renders a section inside "The project so far": forced open
  // (its stage dropdown is the thing that folds) and read-only.
  const mm = moneyMode(detail.phase)
  const sectionView: Record<Section, (inRecord: boolean) => React.ReactNode> = {
    brief: (inRecord) => (
      <>
      {/* ---- what this project is ----
          Sits first because the intake gate reads the brief, and a fact a
          gate reads has to be changeable from the same screen that tells
          you it is blocking. It was not, and a project saved with an empty
          brief could never leave intake. */}
      <details className="sec fold" style={{ marginTop: 18 }}
        data-fold="brief"
        open={inRecord || fold.isOpen('brief')}
        onToggle={(e) => fold.set('brief', e.currentTarget.open)}
      >
        <summary className="sechead">
          {/* The shop's own work has no "they" -- it starts from an idea
              (CG, 13 Oct: "this is an In-House build and the person
              creating the project is coming from their own ideas"). */}
          <h4>{mine ? 'The idea' : 'What they want'}</h4>
          <span className={`secstat ${(detail.brief ?? '').trim().length >= 20 ? 'ok' : 'warn'}`}>
            {(detail.brief ?? '').trim() ? 'written down' : mine ? 'not written yet' : 'nothing written down'}
          </span>
        </summary>
        <div className="pane" style={{ marginBottom: 0 }}>
          <div className="fld" style={{ marginBottom: 0 }}>
            <label className="lbl" htmlFor="p-brief">
              {mine ? 'What you are making, and why' : 'What they asked for'}
            </label>
            <textarea
              id="p-brief"
              rows={3}
              defaultValue={detail.brief ?? ''}
              placeholder={
                mine
                  ? 'Oʻahu at 1:150,000, three times vertical — the third island in the Hawaiian set.'
                  : 'Two lines you can re-read in three weeks.'
              }
              onBlur={(e) => {
                const v = e.target.value.trim() || null
                if (v !== detail.brief) void patch({ brief: v })
              }}
            />
            <div className="hint">
              {mine
                ? 'Saved when you click away — the idea as you see it now, worth having when you come back to it in a month.'
                : 'Saved when you click away — the two lines you will wish you had written when the revision argument starts.'}
            </div>
          </div>
          {!mine && (
            <div className="grid2" style={{ marginTop: 10 }}>
              <div className="fld" style={{ marginBottom: 0 }}>
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
              <div className="fld" style={{ marginBottom: 0 }}>
                <label className="lbl" htmlFor="p-needed">
                  Needed by
                </label>
                <input
                  id="p-needed"
                  type="date"
                  value={facts.neededBy ?? ''}
                  onChange={(e) => void patch({ neededBy: e.target.value || null })}
                />
              </div>
            </div>
          )}
        </div>
      </details>

      </>
    ),
    money: (inRecord) =>
      mine ? null : (
        <>
      {/* ---- money ---- */}
      <details className="sec fold"
        data-fold="money"
        open={inRecord || fold.isOpen('money')}
        onToggle={(e) => fold.set('money', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>{mm === 'price' ? 'The quote' : mm === 'approve' ? 'Quote and deposit' : 'Money'}</h4>
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
          {facts.quoteStatus === null || (detail.quote == null) ? (
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
                {mm !== 'price' && (
                  <Stat
                    label="Deposit owed"
                    value={money(facts.depositOwed)}
                    tone={facts.depositOwed > 0 ? 'crit' : 'ok'}
                    sub={facts.depositDue > 0 ? `of ${money(facts.depositDue)} due` : 'none required'}
                  />
                )}
                {mm === 'payments' && (
                  <Stat
                    label="Balance owed"
                    value={money(facts.balanceOwed)}
                    tone={
                      facts.balanceOwed > 0 && detail.phase === 'delivered'
                        ? 'crit'
                        : facts.balanceOwed > 0
                          ? ''
                          : facts.quoteStatus === 'accepted'
                            ? 'ok'
                            : ''
                    }
                    // Not "paid in full" on a quote nobody has accepted: nothing
                    // has been billed yet, which is a different fact.
                    sub={
                      facts.quoteStatus !== 'accepted'
                        ? 'nothing billed yet'
                        : facts.balanceOwed > 0
                          ? 'still outstanding'
                          : 'paid in full'
                    }
                  />
                )}
              </div>
              {/* A revision made after the client accepted -- from In build,
                  say, when copies changed (CG, 12 Oct). The price that
                  counts stays the accepted one until they accept this; the
                  status control lives in Approval, so without this the
                  revision could never be agreed from here. */}
              {mm === 'payments' && !inRecord && (
                <PendingRevision detail={detail} money={money} busy={busy} onMark={(st) => void markQuote(st)} />
              )}
              <div className="btnrow" style={{ marginTop: 12, alignItems: 'center' }}>
                {mm === 'approve' && (
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
                )}
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
                {mm === 'approve' && (
                  <span className="hint" style={{ marginTop: 0 }}>
                    Move it when the quote actually moves — a quote marked accepted that nobody
                    agreed to is worse than no record at all.
                  </span>
                )}
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

              {mm !== 'price' && (
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
              )}
            </>
          )}
        </div>
      </details>

        </>
      ),
    window: (inRecord) =>
      mine ? null : (
        <>
      {/* ---- the promise ---- */}
      <details className="sec fold"
        data-fold="people"
        open={inRecord || fold.isOpen('people')}
        onToggle={(e) => fold.set('people', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>Delivery window</h4>
          <span className={`secstat ${facts.windowLocked ? 'ok' : 'warn'}`}>
            {facts.windowLocked ? 'committed' : 'still moveable'}
          </span>
        </summary>
        <div className="pane" style={{ marginBottom: 0 }}>
          <div className="grid2">
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

        </>
      ),
    handover: (inRecord) =>
      mine ? null : (
        <>
      {/* ---- what actually happened ---- */}
      <details className="sec fold"
        data-fold="handover"
        open={inRecord || fold.isOpen('handover')}
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
      ),
    build: (inRecord) => (
      <>
      <details className="sec fold"
        data-fold="build"
        open={inRecord || fold.isOpen('build')}
        onToggle={(e) => fold.set('build', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>{mine ? 'Plates and prints' : 'Build sheet'}</h4>
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
            {mine
              ? `${detail.slices.length} file${detail.slices.length === 1 ? '' : 's'} · ${detail.runs.length} print${detail.runs.length === 1 ? '' : 's'} recorded`
              : detail.parts.length === 0
              ? mine
                ? 'nothing on it yet'
                : 'not used on this project'
              : // Checking is Made's job; while working, printed is the count that moves.
                (mine && detail.phase === 'design'
                  ? (() => {
                      const all = detail.parts.reduce((a, p) => a + p.qty, 0)
                      const made = detail.parts.reduce((a, p) => a + p.printedN + p.passedN, 0)
                      return `${made} of ${all} cop${all === 1 ? 'y' : 'ies'} printed`
                    })()
                  : `${facts.partsPassed} of ${facts.parts} passed`) +
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
          whatIf={(parts) => {
            const d2 = { ...detail, parts }
            return {
              price: sheetPriceOf(d2, { rateCard: ctx.rateCard, shop: ctx.shop, materials: ctx.materials, printers: ctx.printers }),
              release: trimHolds(
                schedulePlan(d2, stock, rates.failurePct, holds).material.lines,
                holds.filter((h) => h.jobId === detail.jobId),
              ),
            }
          }}
          onQuoteStatus={(st) => void markQuote(st)}
        />
      </details>

      </>
    ),
    machine: (inRecord) => (
      <details
        className="sec fold"
        data-fold="machine"
        open={inRecord || fold.isOpen('machine')}
        onToggle={(e) => fold.set('machine', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>Machine and material</h4>
          <span
            className={`secstat ${
              !facts.printerId || plan.material.ok === false ? 'warn' : plan.material.ok ? 'ok' : ''
            }`}
          >
            {!facts.printerId
              ? 'no machine picked'
              : plan.material.ok === false
                ? 'short on material'
                : plan.material.ok && !plan.material.allSetAside
                  ? 'material not set aside'
                  : `on ${ctx.printers.find((p) => p.id === facts.printerId)?.name ?? 'a machine'}`}
          </span>
        </summary>
        <div className="pane" style={{ marginBottom: 0 }}>
          <MachineAndMaterial
            ctx={ctx}
            detail={detail}
            plan={plan}
            rows={allRows ?? []}
            busy={busy || inRecord}
            onPick={(id) => void patch({ printerId: id })}
            holds={holds}
            onStocked={() => void reload()}
            onHold={(h) =>
              void (async () => {
                setBusy(true)
                try {
                  await setStockHolds(ctx.shop.id, jobId, ctx.profile.id, h)
                  await reload()
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                } finally {
                  setBusy(false)
                }
              })()
            }
          />
        </div>
      </details>
    ),
    estimate: (inRecord) => (
      <details
        className="sec fold"
        data-fold="estimate"
        open={inRecord || fold.isOpen('estimate')}
        onToggle={(e) => fold.set('estimate', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>Estimated build</h4>
          <span className="secstat">nothing printed yet — an estimate, not a cost</span>
        </summary>
        <div className="pane" style={{ marginBottom: 0 }}>
          <EstimatedBuild ctx={ctx} detail={detail} money={money} jobId={jobId} inRecord={inRecord} />
        </div>
      </details>
    ),
    took: (inRecord) => (
      <>
      {/* ---- what it actually took ---- */}
      <details className="sec fold"
        data-fold="actuals"
        open={inRecord || fold.isOpen('actuals')}
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
              Nobody is paying for this, so there is no quote to measure it against. Prints are
              recorded on their plates above; this adds them up with your own hours. What it cost is
              measured against what it made, below.
            </div>
          ) : comparison === null ? (
            <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
              There is nothing to compare against until this project has a quote. Runs and hours can
              still be logged below — they will line up once it does.
            </div>
          ) : (
            <Variance comparison={comparison} money={money} />
          )}

          {/* Plates are recorded in one place: the build sheet's Plates list,
              when it is on this page (CG, 8 Oct). In the record of a past
              stage, or where the sheet is not shown, this list stands in. */}
          {(inRecord || !workFor(detail.phase, detail.facts.kind).includes('build')) && (
            <FromTheFiles ctx={ctx} detail={detail} busy={busy} onChanged={reload} setError={setError} />
          )}

          <RunLog
            ctx={ctx}
            detail={detail}
            money={money}
            busy={busy}
            onChanged={reload}
            setError={setError}
            platesAbove={!inRecord && workFor(detail.phase, detail.facts.kind).includes('build')}
          />
        </div>
      </details>

      </>
    ),
    made: () => (
      <>
      {/* ---- what it made, for the shop's own work ---- */}
      {detail.facts.kind === 'inhouse' && (
        <MadeItems ctx={ctx} detail={detail} money={money} onChanged={reload} setError={setError} />
      )}

      </>
    ),
    closeout: () => (
      <>
      {/* ---- what it came to, once it is finished ---- */}
      {detail.phase === 'delivered' && (
        <Closeout detail={detail} money={money} locale={rates.locale} jobId={jobId} />
      )}

      </>
    ),
  }
  const behind = isDraft ? [] : stagesBehind(detail.phase, detail.facts.kind)

  return (
    <div className="wrap" style={{ paddingTop: 16, paddingBottom: 96 }}>
      <div style={{ marginBottom: 10 }}>
        <Link to="/projects" className="linkbtn" style={{ fontSize: 12, width: 'auto', display: 'inline' }}>
          ← Projects
        </Link>
        {/* Where this lives in a program. Each step is a link, so getting
            from Oʻahu back up to BathyTopo is one click, not a search. */}
        {/* A piece of a series: the series path, each step a link. */}
        {mySeriesId &&
          [...seriesAncestors(allSeries, mySeriesId), ...allSeries.filter((x) => x.id === mySeriesId)].map((x) => (
            <span key={x.id} style={{ fontSize: 12, color: 'var(--txt-3)' }}>
              {' › '}
              <Link to={`/series/${x.id}`} style={{ color: 'var(--txt-2)' }}>
                {x.name}
              </Link>
            </span>
          ))}
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
          {mine ? (
            <>
              {detail.ref} · your own work
              {detail.facts.neededBy ? ` · aiming for ${detail.facts.neededBy}` : ''}
            </>
          ) : (
            <>
              {detail.ref} · {detail.client.name} · {CLIENT_KIND_LABEL[detail.client.kind]}
              {detail.facts.poc ? ` · ${detail.facts.poc}` : ''}
              {detail.facts.neededBy ? ` · due ${detail.facts.neededBy}` : ' · no due date'}
            </>
          )}
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

      {/* Your own work does not move through stages: it keeps taking plates
          until you archive it (CG, 21 Oct: "The project doesn't close"). */}
      {mine ? (
        <div className="hint" style={{ marginTop: 12 }}>
          Ongoing — upload plates, record what came off, and send pieces to the shelf or into an
          assembly as they come. Archive it when you retire it.
          {facts.archivedAt ? ' Archived.' : ''}
        </div>
      ) : (
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
              onClick={() => setViewPhase(p === detail.phase ? null : p)}
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
      )}

      {/* Moving backwards lives HERE, beside the stages, not inside the gate
          section -- which is folded shut on a finished project, and is
          exactly where CG never saw it. Voltage's rule: going back needs a
          reason, and the reason goes on the record. */}
      {!isDraft && !mine && here > 0 && (
        <div style={{ marginTop: 8 }}>
          {!backOpen ? (
            <button type="button" className="btn sm" disabled={busy} onClick={() => setBackOpen(true)}>
              ← Move back a stage
            </button>
          ) : (
            <MoveBack
              stages={ladder.slice(0, here).map((p) => ({ value: p, label: label(p) }))}
              busy={busy}
              onCancel={() => setBackOpen(false)}
              onMove={async (to, why) => {
                await moveBack(to, why)
                setBackOpen(false)
              }}
            />
          )}
        </div>
      )}

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

      {/* ---- flags, spelled out ---- */}
      {flags.length > 0 && (
        <FlagPanel
          flags={flags}
          busy={busy}
          onClear={(key) => (key === 'over-ceiling' ? patch({ overCeiling: null }) : undefined)}
        />
      )}


      {/* ---- the project so far ----
          Everything earlier stages did, filed under the stage that did it,
          read-only. Closed while there is work to do; open on a finished
          project, where it IS the page (CG, 7 Oct: "the last stage is a
          review of the entire project"). */}
      <details
        className="sec fold"
        data-fold="sofar"
        style={{ marginTop: 18 }}
        open={fold.isOpen('sofar')}
        onToggle={(e) => fold.set('sofar', e.currentTarget.open)}
      >
        <summary className="sechead">
          <h4>The project so far</h4>
          <span className="secstat">
            {behind.length === 0
              ? 'just started'
              : `${behind.length} stage${behind.length === 1 ? '' : 's'} behind this one`}
            {` · ${detail.events.length} entr${detail.events.length === 1 ? 'y' : 'ies'} in Activity`}
          </span>
        </summary>
        <div className="stack" style={{ gap: 6 }}>
          {behind.map((p) => {
            const g = gateStatus(p, detail.gates[p] ?? {}, facts)
            const skipped = g.items.filter((i) => i.skipped).length
            const secs = recordFor(p, detail.phase, detail.facts.kind)
            return (
              <details key={p} className="sofar-stage">
                <summary className="sechead">
                  <h4>{label(p)}</h4>
                  <span className={`secstat ${g.blocked ? 'warn' : 'ok'}`}>
                    {g.total === 0 ? 'no gate' : `${g.done} of ${g.total} cleared`}
                    {skipped > 0 ? ` · ${skipped} skipped` : ''}
                  </span>
                </summary>
                <div className="pane" style={{ marginBottom: 6 }}>
                  {g.items.map((i) => (
                    <div key={i.key} className="histitem">
                      <span style={{ color: i.skipped ? 'var(--warn)' : i.checked ? 'var(--ok)' : 'var(--txt-3)' }}>
                        {i.skipped ? '↷' : i.checked ? '✓' : '·'}
                      </span>
                      <span>{i.label}</span>
                      {i.skipped && <div className="histnote">Skipped — {i.skipped}</div>}
                      {!i.skipped && i.note && <div className="histnote">{i.note}</div>}
                    </div>
                  ))}
                  {g.total === 0 && <div className="hint">Nothing to check at this stage.</div>}
                </div>
                {secs.length > 0 && (
                  <fieldset disabled className="record">
                    {secs.map((sec) => (
                      <Fragment key={sec}>{sectionView[sec](true)}</Fragment>
                    ))}
                  </fieldset>
                )}
              </details>
            )
          })}
          {/* ---- the family ----
          Every project, client or the shop's own, is filed in a SERIES
          (0026_series.sql). CG, 23 Oct: a client project's question is
          "what series should this go to, not programs or projects" -- the
          old program picker offered in-house projects as parents. It is
          kept only where a client project still has such a link, so it can
          be seen and undone; nothing new is ever filed that way. */}
      <SeriesSection
        ctx={ctx}
        jobId={detail.jobId}
        seriesId={mySeriesId}
        all={allSeries}
        client={detail.facts.kind !== 'inhouse'}
        busy={busy}
        onChanged={reload}
        setError={setError}
      />
      {detail.facts.kind !== 'inhouse' &&
        allRows &&
        (childrenOf(allRows, detail.jobId).length > 0 || ancestorsOf(allRows, detail.jobId).length > 0) && (
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

        </div>
      </details>

      {/* ---- this stage's work: only what moves it forward ---- */}
      {workFor(detail.phase, detail.facts.kind).map((sec) => (
        <Fragment key={sec}>{sectionView[sec](false)}</Fragment>
      ))}

      {/* ---- the gate: last, so it is the thing the page ends on ---- */}
      {detail.phase !== 'delivered' && !mine && (
        <>
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
              {mine
                ? 'Done — nothing left to check off. It stays on the board until you archive it; archiving files it away and keeps every figure counting.'
                : 'Delivered is the end of the line — there is nothing left to check off. What matters now is whether the balance came in, which is in Money below.'}
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
            {shown === 'approval' && detail.phase === 'approval' && facts.kind === 'client' && (
              <GoAheadWithout
                items={gate.items}
                busy={busy}
                onGo={(why) => void goAheadWithout(why)}
              />
            )}
            <div className="ggroup">Required before advancing</div>
            {gate.items.map((item) => (
              <GateRow
                key={item.key}
                item={item}
                onToggle={(c) => void toggleGate(item, c)}
                onNote={(t) => void saveGateNote(item, t)}
                onSkip={(r) => void skipItem(item, r)}
              />
            ))}
            {/* The live stage's reason is already in the bar at the bottom,
                beside the button it explains; said twice it read as noise.
                A past stage, looked at from the record, still says its own. */}
            {gate.blocked && shown !== detail.phase && <div className="gblock">{gate.reason}</div>}
          </div>
        )}
      </details>

        </>
      )}

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
          {mine
            ? 'Ongoing — it stays open for the next plate.'
            : !isDraft
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
        {(detail.phase === 'delivered' || mine) && (
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
        {!isDraft && !mine && here > 0 && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            title="Something needs fixing? Open the earlier stage and say why."
            onClick={() => {
              setBackOpen(true)
              window.scrollTo?.({ top: 0, behavior: 'smooth' })
            }}
          >
            ← Back to {label(ladder[here - 1])}
          </button>
        )}
        {mine ? null : !isDraft ? (
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
          onClick={() => {
            // Fill from what is owed NOW, not when the page first drew:
            // after the deposit lands the form must not offer it again.
            setKind(suggestion?.kind ?? 'balance')
            setAmount(suggestion ? suggestion.amount.toFixed(2) : '')
            setOpen(true)
          }}
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
/**
 * Where one object of a file goes on the build sheet (CG, 16 Oct). A select
 * of "New part" and the parts already there, with the name of the new part
 * editable, and why a same-named part was not picked when it was not.
 */
function SortPick({
  id,
  objectLabel,
  fileName,
  guess,
  parts,
  joins = [],
  onChange,
}: {
  id: string
  objectLabel: string
  /** The file, when it holds this object alone -- offered as a name. */
  fileName: string | null
  guess: SortGuess | undefined
  parts: PartRow[]
  /** New parts earlier files of the same batch are making. */
  joins?: string[]
  onChange: (g: SortGuess) => void
}) {
  const choice: SortChoice = guess?.choice ?? { kind: 'new', label: objectLabel }
  const [name, setName] = useState(choice.kind === 'new' ? choice.label : objectLabel)
  const fromFile = fileName ? nameFromFile(fileName) : null
  const taken = parts.map((p) => p.label)
  const samePart = parts.find((p) => p.label.trim().toLowerCase() === objectLabel.trim().toLowerCase()) ?? null
  /** The file's name and the object's name, each made unique against the
   *  build sheet -- and whatever is typed now, so it stays one of them. */
  const suggestions = [
    ...new Map(
      [fromFile, objectLabel]
        .filter((n): n is string => !!n && !!n.trim())
        .map((n) => uniqueLabel(n.trim(), taken))
        .map((n) => [n.toLowerCase(), n] as const),
    ).values(),
  ]
  const sizeOf = (p: PartRow) => {
    const s = partSizes(p)[0]
    if (!s) return ''
    const bits = [s.grams != null ? `${Math.round(s.grams)} g` : null, s.minutes != null ? fmtHours(s.minutes / 60) : null].filter(Boolean)
    return bits.length ? ` · ${bits.join(', ')} a copy` : ''
  }
  return (
    <div className="sortpick">
      <select
        id={id}
        aria-label={`Where ${objectLabel} goes`}
        value={choiceValue(choice)}
        onChange={(e) => onChange({ choice: choiceFrom(e.target.value, name), why: null })}
      >
        <option value="new">New part</option>
        {parts.length > 0 && (
          <optgroup label="Already on the build sheet">
            {parts.map((p) => (
              <option key={p.id} value={`part:${p.id}`}>
                {p.label}
                {sizeOf(p)}
              </option>
            ))}
          </optgroup>
        )}
        {joins.length > 0 && (
          <optgroup label="New from a file above">
            {[...new Set(joins)].map((l) => (
              <option key={l} value={`join:${l}`}>
                {l}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {choice.kind === 'new' && (
        <input
          aria-label={`Name the new part for ${objectLabel}`}
          value={choice.label}
          onChange={(e) => {
            setName(e.target.value)
            onChange({ choice: { kind: 'new', label: e.target.value }, why: guess?.why ?? null })
          }}
        />
      )}
      {/* Every name worth giving it, one click each (CG, 23 Oct: "I used to
          be able to add a new part based on the name the file was imported
          as ... doesn't allow me to click on the suggested name"). The one
          in use is marked rather than hidden, so the choice never vanishes. */}
      {choice.kind === 'new' &&
        (suggestions.length > 1 || (suggestions.length === 1 && suggestions[0].toLowerCase() !== choice.label.trim().toLowerCase())) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 4, fontSize: 11 }}>
          <span style={{ color: 'var(--txt-3)' }}>Name it:</span>
          {suggestions.map((n) => {
            const on = n.toLowerCase() === choice.label.trim().toLowerCase()
            return (
              <button
                key={n}
                type="button"
                className={`btn sm${on ? ' primary' : ''}`}
                aria-pressed={on}
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => {
                  setName(n)
                  onChange({ choice: { kind: 'new', label: n }, why: guess?.why ?? null })
                }}
              >
                {n}
              </button>
            )
          })}
        </div>
      )}
      {guess?.why && (
        <div className="hint" style={{ marginTop: 4, color: 'var(--warn)' }}>
          {guess.why}
          {samePart && choice.kind === 'new' && (
            <>
              {' '}
              <button
                type="button"
                className="btn sm"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => onChange({ choice: { kind: 'part', partId: samePart.id }, why: guess.why })}
              >
                It is {samePart.label}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A plate that stopped or failed: did anything on it come off OK? (CG, 24
 * Oct.) Asked, never assumed -- a stopped plate often has whole objects done
 * and others half-built. Ticked parts are marked printed; the rest failed,
 * so the parts list says exactly what has to print again.
 */
function CameOffOk({
  id,
  labels,
  ok,
  onChange,
}: {
  id: string
  labels: string[]
  ok: string[]
  onChange: (ok: string[]) => void
}) {
  return (
    <div className="fld" role="group" aria-label="What came off OK" id={id} style={{ marginTop: 8 }}>
      <div className="lbl">Did anything on the plate come off OK?</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, marginTop: 4 }}>
        {labels.map((l) => (
          <label key={l} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={ok.includes(l)}
              onChange={(e) => onChange(e.target.checked ? [...ok, l] : ok.filter((x) => x !== l))}
            />
            {l}
          </label>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 4 }}>
        {ok.length === 0
          ? 'Nothing ticked: every part on the plate is marked failed.'
          : ok.length === labels.length
            ? 'Everything ticked: every part is marked printed — then it came off clean; say so above instead.'
            : `${ok.join(', ')} marked printed; ${labels.filter((l) => !ok.includes(l)).join(', ')} marked failed.`}
      </div>
    </div>
  )
}

/**
 * Each object on a plate, ticked when it came off (CG, 21 Oct: "if a
 * specific part failed we can mark it with the appropriate information
 * like weight"). Untick one and say what it weighs; the rest came off.
 */
function ObjectResults({
  id,
  results,
  unit,
  onChange,
}: {
  id: string
  results: ObjectResult[]
  unit: string
  onChange: (r: ObjectResult[]) => void
}) {
  if (!results.length) return null
  const set = (i: number, p: Partial<ObjectResult>) => onChange(results.map((r, k) => (k === i ? { ...r, ...p } : r)))
  return (
    <div className="objresults" role="group" aria-label="What came off the plate">
      <div className="lbl" style={{ marginBottom: 4 }}>
        What came off — untick anything that failed
      </div>
      {results.map((r, i) => (
        <div key={`${r.label}-${i}`} className={`objrow ${r.failed ? 'failed' : ''}`.trim()}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
            <input
              type="checkbox"
              checked={!r.failed}
              aria-label={`${r.label}${results.filter((x) => x.label === r.label).length > 1 ? ` #${results.slice(0, i + 1).filter((x) => x.label === r.label).length}` : ''} came off`}
              onChange={(e) => set(i, { failed: !e.target.checked, weighed: e.target.checked ? null : r.weighed })}
            />
            <span>{r.label}</span>
            <span className="pmeta">{r.grams != null ? `${Math.round(r.grams * 10) / 10} ${unit}` : ''}</span>
          </label>
          {r.failed && (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="pmeta" style={{ color: 'var(--red)' }}>failed · weighs</span>
              <input
                id={`${id}-w-${i}`}
                aria-label={`What the failed ${r.label} weighs`}
                inputMode="decimal"
                style={{ width: 80 }}
                value={r.weighed ?? ''}
                placeholder={r.grams != null ? String(Math.round(r.grams)) : unit}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  const n = Number(v)
                  set(i, { weighed: v && Number.isFinite(n) && n >= 0 ? n : null })
                }}
              />
              <span className="pmeta">{unit}</span>
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/** The objects of a saved plate, each copy once, named as sorted. */
function objectsOf(slice: SliceImportRow, parts: PartRow[]): PlateObject[] {
  return plateObjects(
    slice.sections.map((sec) => ({
      id: sec.id,
      label: parts.find((p) => p.id === sec.partId)?.label ?? sec.label,
      qty: sec.qty,
      estGrams: sec.estGrams,
    })),
    slice.estGrams,
  )
}

/**
 * What one recorded print made, ready to write: every object with its share
 * of the print's cost. A whole plate that failed fails every object, each at
 * its share of what came off the spool.
 */
function madeFromPrint(
  ctx: ShopContext,
  run: PrintRunInput,
  objects: PlateObject[],
  results: ObjectResult[] | null,
): MadeItemInput[] {
  if (!objects.length) return []
  const total = runCost(run, ctx.materials, ctx.printers, ctx.shop.electricity_rate_kwh == null ? null : Number(ctx.shop.electricity_rate_kwh))
  let rs: ObjectResult[]
  if (run.outcome === 'success') rs = results && results.length === objects.length ? results : objects.map((o) => ({ ...o, failed: false, weighed: null }))
  else {
    const g = objects.reduce((a, o) => a + (o.grams ?? 0), 0)
    rs = objects.map((o) => ({ ...o, failed: true, weighed: g > 0 && o.grams != null ? (Number(run.unitsUsed) || 0) * (o.grams / g) : null }))
  }
  const split = splitCost(rs, total)
  return rs.map((r, i) => ({
    sectionId: r.sectionId,
    label: r.label,
    grams: split[i].grams == null ? null : Math.round(split[i].grams! * 10) / 10,
    unitCost: split[i].unitCost,
    failed: r.failed,
    note: r.failed ? run.failureReason ?? null : null,
  }))
}

/** One object of a file being read in, named as the card sorted it. */
function objectsOfRead(read: SliceFile, sorts: SortGuess[], parts: PartRow[]): PlateObject[] {
  return plateObjects(
    read.sections.map((sec, j) => {
      const c = sorts[j]?.choice
      const label = !c ? sec.label : c.kind === 'part' ? (parts.find((p) => p.id === c.partId)?.label ?? sec.label) : c.label
      return { id: `pending-${j}`, label, qty: sec.qty, estGrams: sec.estGrams }
    }),
    read.totals.estGrams,
  ).map((o) => ({ ...o, sectionId: o.sectionId }))
}

/**
 * What this project has made, piece by piece, and where each piece went
 * (CG, 21 Oct: "upload the plate, sort the parts, and send them
 * individually to the made section. The project doesn't close or end.").
 *
 * Every object off a recorded print is here at its share of that print's
 * cost. Not placed yet, it can go to the shelf as a product (one batch, at
 * the pieces' average cost), into an assembly -- "Maui display", with what
 * it needs -- or be kept. A finished assembly goes to the shelf as one unit
 * at the sum of what is in it. Katana's pattern (a sub-assembly is also a
 * product), kept light.
 */
function MadeItems({
  ctx,
  detail,
  money,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  money: (n: number) => string
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const [items, setItems] = useState<MadeItemRow[] | null>(null)
  const [assemblies, setAssemblies] = useState<AssemblyRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [dest, setDest] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const [asmName, setAsmName] = useState('')
  const [asmNeeds, setAsmNeeds] = useState<{ label: string; qty: string }[]>([{ label: '', qty: '1' }])
  const [finishing, setFinishing] = useState<string | null>(null)
  const [finishTo, setFinishTo] = useState('')
  const [finishName, setFinishName] = useState('')
  // Pieces from a print with no file -- an evening of keychains typed in by hand.
  const [handRun, setHandRun] = useState('')
  const [handName, setHandName] = useState('')
  const [handN, setHandN] = useState('')

  const load = useCallback(async () => {
    try {
      const [it, as, pr] = await Promise.all([
        listMadeItems(ctx.shop.id, detail.jobId),
        listAssemblies(ctx.shop.id, detail.jobId),
        listShelf(ctx.shop.id).catch(() => [] as ProductRow[]),
      ])
      setItems(it)
      setAssemblies(as)
      setProducts(pr.filter((p) => !p.archived))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [ctx.shop.id, detail.jobId, setError])
  // Read again whenever a print is recorded, corrected or removed.
  const runKey = detail.runs.map((r) => `${r.id}:${r.unitsUsed}:${r.outcome}`).join('|')
  useEffect(() => {
    void load()
  }, [load, runKey])

  async function act(fn: () => Promise<unknown>, msg?: string) {
    setBusy(true)
    setError(null)
    setSaid(null)
    try {
      await fn()
      setPicked(new Set())
      setDest('')
      setNewName('')
      await load()
      await onChanged()
      if (msg) setSaid(msg)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (items == null) return null
  const unplaced = items.filter((i) => i.status === 'made')
  const failed = items.filter((i) => i.status === 'failed')
  const placed = items.filter((i) => i.status === 'shelved' || i.status === 'kept')
  const open = assemblies.filter((a) => a.status === 'open')
  const done = assemblies.filter((a) => a.status === 'done')
  const inAsm = (id: string) => items.filter((i) => i.assemblyId === id)
  const labels = [...new Set(items.map((i) => i.label))]

  // Prints recorded before pieces were tracked: offer to make their pieces.
  const withItems = new Set(items.map((i) => i.runId))
  const older = detail.runs.filter((r) => !withItems.has(r.id) && r.sliceImportId && detail.slices.some((x) => x.id === r.sliceImportId))
  const oldBatches = products.flatMap((p) => p.batches.filter((b) => b.job_id === detail.jobId))

  const pick = (ids: string[], on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur)
      for (const id of ids) on ? next.add(id) : next.delete(id)
      return next
    })
  const chosen = unplaced.filter((i) => picked.has(i.id))
  const chosenCost = chosen.reduce((a, i) => a + i.unitCost, 0)
  const noFile = detail.runs.filter((r) => !withItems.has(r.id) && !r.sliceImportId)
  // The design behind this work goes on the first product it makes, once --
  // an investment to pay back, never folded into a unit cost.
  const split = splitJobCost(
    { actualCost: detail.facts.actualCost, designHours: detail.actuals.designHours },
    Number(ctx.rateCard.design_hourly),
  )
  const designDone = products.some((p) => p.design_job_id === detail.jobId && p.design_cost != null)
  const design = designDone || split.design <= 0 ? {} : { designCost: split.design, designHours: detail.actuals.designHours }

  return (
    <section className="sec" data-fold="made-items">
      <div className="sechead">
        <h4>Made</h4>
        <span className="secstat">
          {unplaced.length} not placed yet · {placed.filter((i) => i.status === 'shelved').length} on the shelf
          {open.length ? ` · ${open.length} assembl${open.length === 1 ? 'y' : 'ies'} open` : ''}
        </span>
      </div>
      <div className="pane" style={{ marginBottom: 0 }} role="region" aria-label="Made">
        {older.length > 0 && (
          <div className="attn warn" role="note" aria-label="Older prints" style={{ marginTop: 0, marginBottom: 10 }}>
            <span style={{ flex: 1 }}>
              {older.length} print{older.length === 1 ? '' : 's'} recorded before pieces were tracked.
              Make their pieces from the plates — what came off clean is made, a failed plate&rsquo;s pieces
              are failures.
              {oldBatches.length > 0 &&
                ` This project already put ${oldBatches.reduce((a, b) => a + Number(b.units_made), 0)} on the shelf the old way; mark those pieces Kept so they are not shelved twice.`}
            </span>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  for (const r of older) {
                    const slice = detail.slices.find((x) => x.id === r.sliceImportId)!
                    const run: PrintRunInput = {
                      printerId: r.printerId ?? '',
                      materialId: r.materialId,
                      unitsUsed: r.unitsUsed ?? 0,
                      hours: r.hours ?? 0,
                      outcome: r.outcome ?? 'success',
                      failureReason: r.failureReason,
                      note: r.note,
                      startedAt: r.startedAt,
                    }
                    await recordMadeItems(ctx.shop.id, detail.jobId, r.id, madeFromPrint(ctx, run, objectsOf(slice, detail.parts), null))
                  }
                }, 'Pieces made from the older prints.')
              }
            >
              Make their pieces
            </button>
          </div>
        )}
        {said && (
          <div className="hint" role="status" style={{ marginTop: 0, marginBottom: 8, color: 'var(--ok)' }}>
            {said}
          </div>
        )}

        <div className="lbl">Not placed yet</div>
        {unplaced.length === 0 ? (
          <div className="hint" style={{ marginTop: 2 }}>
            Nothing waiting. Record a plate above and what came off it lands here.
          </div>
        ) : (
          <table className="madelist">
            <tbody>
              {unplaced.map((i) => (
                <tr key={i.id}>
                  <td style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      aria-label={`Pick ${i.label} from ${i.printedOn ?? 'a print'}`}
                      checked={picked.has(i.id)}
                      onChange={(e) => pick([i.id], e.target.checked)}
                    />
                  </td>
                  <td>
                    <span className="pn">{i.label}</span>
                    <span className="pmeta">
                      {' '}
                      · {i.printedOn ?? '—'}
                      {i.fileName ? ` · ${i.fileName}` : ''}
                    </span>
                  </td>
                  <td className="r mono">{i.grams != null ? `${Math.round(i.grams)} g` : ''}</td>
                  <td className="r mono">{money(i.unitCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {noFile.length > 0 && (
          <div className="btnrow" style={{ marginTop: 8, alignItems: 'flex-end' }} role="group" aria-label="Pieces from a print with no file">
            <div className="fld" style={{ margin: 0, minWidth: 200 }}>
              <label className="lbl" htmlFor="hand-run">
                A print with no file made
              </label>
              <select id="hand-run" value={handRun} onChange={(e) => setHandRun(e.target.value)}>
                <option value="">Choose the print…</option>
                {noFile.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.startedAt?.slice(0, 10) ?? 'undated'} · {r.unitsUsed ?? 0} {r.unit ?? 'g'} · {fmtHours(r.hours ?? 0)}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld" style={{ margin: 0, width: 90 }}>
              <label className="lbl" htmlFor="hand-n">
                How many
              </label>
              <input id="hand-n" type="number" min={1} value={handN} onChange={(e) => setHandN(e.target.value)} />
            </div>
            <div className="fld" style={{ margin: 0, flex: 1, minWidth: 160 }}>
              <label className="lbl" htmlFor="hand-name">
                Of what
              </label>
              <input id="hand-name" value={handName} placeholder="Hex keychain" onChange={(e) => setHandName(e.target.value)} />
            </div>
            <button
              type="button"
              className="btn sm"
              disabled={busy || !handRun || !(Number(handN) >= 1) || !handName.trim()}
              onClick={() => {
                const r = noFile.find((x) => x.id === handRun)!
                const n = Math.floor(Number(handN))
                const run: PrintRunInput = {
                  printerId: r.printerId ?? '',
                  materialId: r.materialId,
                  unitsUsed: r.unitsUsed ?? 0,
                  hours: r.hours ?? 0,
                  outcome: r.outcome ?? 'success',
                  failureReason: r.failureReason,
                  note: r.note,
                  startedAt: r.startedAt,
                }
                const each = (r.unitsUsed ?? 0) / n
                const objs = Array.from({ length: n }, () => ({ sectionId: null, label: handName.trim(), grams: each }))
                void act(async () => {
                  await recordMadeItems(ctx.shop.id, detail.jobId, r.id, madeFromPrint(ctx, run, objs, null))
                  setHandRun('')
                  setHandN('')
                  setHandName('')
                }, `${n} × ${handName.trim()} made.`)
              }}
            >
              Make them
            </button>
          </div>
        )}
        {unplaced.length > 1 && (
          <button
            type="button"
            className="linkbtn"
            style={{ fontSize: 11, width: 'auto', marginTop: 2 }}
            onClick={() => pick(unplaced.map((i) => i.id), picked.size !== unplaced.length)}
          >
            {picked.size === unplaced.length ? 'Pick none' : 'Pick all'}
          </button>
        )}
        {chosen.length > 0 && (
          <div className="gatebox" style={{ marginTop: 8 }} role="group" aria-label="Place the picked pieces">
            <div className="btnrow" style={{ margin: 0, alignItems: 'flex-end' }}>
              <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220 }}>
                <label className="lbl" htmlFor="made-dest">
                  {chosen.length} picked · {money(chosenCost)} — send to
                </label>
                <select id="made-dest" value={dest} onChange={(e) => setDest(e.target.value)}>
                  <option value="">Choose…</option>
                  <optgroup label="The shelf, to sell">
                    <option value="shelf:new">A new product…</option>
                    {products.map((p) => (
                      <option key={p.id} value={`shelf:${p.id}`}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                  {open.length > 0 && (
                    <optgroup label="Into an assembly">
                      {open.map((a) => (
                        <option key={a.id} value={`asm:${a.id}`}>
                          {a.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <option value="kept">Keep — not for sale</option>
                </select>
              </div>
              {dest === 'shelf:new' && (
                <div className="fld" style={{ margin: 0, flex: 1, minWidth: 180 }}>
                  <label className="lbl" htmlFor="made-newname">
                    Product name
                  </label>
                  <input
                    id="made-newname"
                    value={newName}
                    placeholder={chosen[0]?.label}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
              )}
              <button
                type="button"
                className="btn sm primary"
                disabled={busy || !dest}
                onClick={() => {
                  const ids = chosen.map((i) => i.id)
                  if (dest === 'kept') return void act(() => placeItems(ctx.shop.id, detail.jobId, ids, { kind: 'kept' }), `${ids.length} kept.`)
                  if (dest.startsWith('asm:'))
                    return void act(
                      () => placeItems(ctx.shop.id, detail.jobId, ids, { kind: 'assembly', assemblyId: dest.slice(4) }),
                      `${ids.length} into ${open.find((a) => `asm:${a.id}` === dest)?.name}.`,
                    )
                  const productId = dest === 'shelf:new' ? null : dest.slice(6)
                  const name = productId ? products.find((p) => p.id === productId)?.name : newName.trim() || chosen[0]?.label
                  void act(
                    () => placeItems(ctx.shop.id, detail.jobId, ids, { kind: 'shelf', productId, name, madeOn: todayISO(), ...(productId ? {} : design) }),
                    `${ids.length} × ${name} on the shelf at ${money(chosenCost / ids.length)} each.`,
                  )
                }}
              >
                Send
              </button>
            </div>
          </div>
        )}

        <div className="lbl" style={{ marginTop: 14 }}>
          Assemblies
        </div>
        {open.map((a) => {
          const inside = inAsm(a.id)
          const st = assemblyStatus(a.needs, inside)
          const cost = inside.reduce((t, i) => t + i.unitCost, 0)
          return (
            <div key={a.id} className="asm" role="group" aria-label={`Assembly ${a.name}`}>
              <div className="asmhead">
                <b>{a.name}</b>
                <span className="pmeta">
                  {inside.length} piece{inside.length === 1 ? '' : 's'} · {money(cost)}
                  {a.needs.length ? (st.complete ? ' · has everything it needs' : ` · ${st.missing} still missing`) : ''}
                </span>
              </div>
              {st.lines.length > 0 && (
                <div className="asmneeds">
                  {st.lines.map((l) => (
                    <span key={l.label} className={`chip ${l.missing ? '' : 'on'}`.trim()} style={{ color: l.missing ? 'var(--warn)' : 'var(--ok)' }}>
                      {l.label} {l.have}/{l.qty}
                    </span>
                  ))}
                </div>
              )}
              {inside.map((i) => (
                <div key={i.id} className="histitem">
                  <span>{i.label}</span>
                  <span className="pmeta">{money(i.unitCost)}</span>
                  <button
                    type="button"
                    className="linkbtn"
                    style={{ marginLeft: 'auto', fontSize: 11, width: 'auto', marginTop: 0 }}
                    disabled={busy}
                    aria-label={`Take ${i.label} out of ${a.name}`}
                    onClick={() => void act(() => placeItems(ctx.shop.id, detail.jobId, [i.id], { kind: 'back' }))}
                  >
                    take out
                  </button>
                </div>
              ))}
              {finishing === a.id ? (
                <div className="btnrow" style={{ marginTop: 6, alignItems: 'flex-end' }}>
                  <div className="fld" style={{ margin: 0, minWidth: 200 }}>
                    <label className="lbl" htmlFor={`fin-${a.id}`}>
                      Finished — it goes to
                    </label>
                    <select id={`fin-${a.id}`} value={finishTo} onChange={(e) => setFinishTo(e.target.value)}>
                      <option value="shelf:new">The shelf, as a new product</option>
                      {products.map((p) => (
                        <option key={p.id} value={`shelf:${p.id}`}>
                          The shelf, as {p.name}
                        </option>
                      ))}
                      <option value="kept">Kept — not for sale</option>
                    </select>
                  </div>
                  {finishTo === 'shelf:new' && (
                    <div className="fld" style={{ margin: 0, minWidth: 180 }}>
                      <label className="lbl" htmlFor={`fin-name-${a.id}`}>
                        Product name
                      </label>
                      <input id={`fin-name-${a.id}`} value={finishName} onChange={(e) => setFinishName(e.target.value)} />
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={busy || !inside.length}
                    onClick={() =>
                      void act(
                        () =>
                          finishAssembly(
                            ctx.shop.id,
                            a.id,
                            finishTo === 'kept'
                              ? { kind: 'kept' }
                              : {
                                  kind: 'shelf',
                                  productId: finishTo === 'shelf:new' ? null : finishTo.slice(6),
                                  name: finishName.trim() || a.name,
                                  madeOn: todayISO(),
                                },
                          ).then(() => setFinishing(null)),
                        finishTo === 'kept' ? `${a.name} finished and kept.` : `${a.name} on the shelf at ${money(cost)}.`,
                      )
                    }
                  >
                    Finish it
                  </button>
                  <button type="button" className="btn sm" onClick={() => setFinishing(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="btnrow" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || !inside.length}
                    title={inside.length ? undefined : 'Send pieces into it first.'}
                    onClick={() => {
                      setFinishing(a.id)
                      setFinishTo('shelf:new')
                      setFinishName(a.name)
                    }}
                  >
                    Finish {a.name}
                  </button>
                  <button
                    type="button"
                    className="linkbtn"
                    style={{ fontSize: 11, width: 'auto', marginTop: 0 }}
                    disabled={busy}
                    onClick={() => void act(() => deleteAssembly(ctx.shop.id, a.id))}
                  >
                    remove (pieces go back)
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {!making ? (
          <button type="button" className="btn sm" style={{ marginTop: 6 }} onClick={() => setMaking(true)}>
            + New assembly
          </button>
        ) : (
          <div className="gatebox" style={{ marginTop: 6 }} role="group" aria-label="New assembly">
            <div className="fld" style={{ margin: 0 }}>
              <label className="lbl" htmlFor="asm-name">
                What it is
              </label>
              <input id="asm-name" value={asmName} placeholder="Maui display" onChange={(e) => setAsmName(e.target.value)} />
            </div>
            <div className="lbl" style={{ marginTop: 8 }}>
              What it needs (optional — it then says what is still missing)
            </div>
            <datalist id="asm-labels">
              {labels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            {asmNeeds.map((n, k) => (
              <div key={k} className="btnrow" style={{ margin: '4px 0 0' }}>
                <input
                  aria-label={`Needs, line ${k + 1}`}
                  list="asm-labels"
                  value={n.label}
                  placeholder="Maui BATHY 3x"
                  style={{ flex: 1 }}
                  onChange={(e) => setAsmNeeds((xs) => xs.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)))}
                />
                <input
                  aria-label={`How many, line ${k + 1}`}
                  type="number"
                  min={1}
                  value={n.qty}
                  style={{ width: 70 }}
                  onChange={(e) => setAsmNeeds((xs) => xs.map((x, j) => (j === k ? { ...x, qty: e.target.value } : x)))}
                />
              </div>
            ))}
            <div className="btnrow" style={{ marginTop: 6 }}>
              <button type="button" className="linkbtn" style={{ fontSize: 11, width: 'auto' }} onClick={() => setAsmNeeds((xs) => [...xs, { label: '', qty: '1' }])}>
                + another
              </button>
            </div>
            <div className="btnrow" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn sm primary"
                disabled={busy || !asmName.trim()}
                onClick={() =>
                  void act(async () => {
                    await saveAssembly(ctx.shop.id, detail.jobId, {
                      name: asmName,
                      needs: asmNeeds.map((n) => ({ label: n.label, qty: Number(n.qty) || 0 })),
                    })
                    setMaking(false)
                    setAsmName('')
                    setAsmNeeds([{ label: '', qty: '1' }])
                  }, `${asmName.trim()} started.`)
                }
              >
                Start it
              </button>
              <button type="button" className="btn sm" onClick={() => setMaking(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {(placed.length > 0 || done.length > 0 || failed.length > 0) && (
          <details style={{ marginTop: 14 }}>
            <summary className="lbl" style={{ cursor: 'pointer' }}>
              Placed and failed — {placed.length + done.length} placed · {failed.length} failed
            </summary>
            {done.map((a) => (
              <div key={a.id} className="histitem">
                <span style={{ color: 'var(--ok)' }}>✓</span>
                <span>
                  {a.name} — {a.batchId ? 'on the shelf' : 'kept'} · {inAsm(a.id).length} pieces ·{' '}
                  {money(inAsm(a.id).reduce((t, i) => t + i.unitCost, 0))}
                </span>
                <span className="pmeta">{a.doneAt?.slice(0, 10)}</span>
              </div>
            ))}
            {placed.map((i) => (
              <div key={i.id} className="histitem">
                <span style={{ color: 'var(--ok)' }}>✓</span>
                <span>
                  {i.label} —{' '}
                  {i.status === 'shelved' ? (
                    <Link to="/shelf">{products.find((p) => p.batches.some((b) => b.id === i.batchId))?.name ?? 'on the shelf'} on the Shelf →</Link>
                  ) : (
                    'kept'
                  )}
                </span>
                <span className="pmeta">
                  {money(i.unitCost)} · {i.placedAt?.slice(0, 10)}
                </span>
                {i.status === 'kept' && (
                  <button
                    type="button"
                    className="linkbtn"
                    style={{ marginLeft: 'auto', fontSize: 11, width: 'auto', marginTop: 0 }}
                    disabled={busy}
                    onClick={() => void act(() => placeItems(ctx.shop.id, detail.jobId, [i.id], { kind: 'back' }))}
                  >
                    not kept after all
                  </button>
                )}
              </div>
            ))}
            {failed.map((i) => (
              <div key={i.id} className="histitem">
                <span style={{ color: 'var(--red)' }}>✕</span>
                <span>
                  {i.label} failed · {i.grams != null ? `${Math.round(i.grams)} g · ` : ''}
                  {money(i.unitCost)} lost
                </span>
                <span className="pmeta">{i.printedOn}</span>
                {i.note && <div className="histnote">{i.note}</div>}
              </div>
            ))}
          </details>
        )}
      </div>
    </section>
  )
}

/** One file read and waiting for a yes: everything the review card asks. */
interface PendingFile {
  key: string
  read: SliceFile
  /** The file's own bytes, packed for storage. Null when over the cap. */
  kept: KeptFile | null
  tooBig: string | null
  printerId: string
  materialId: string
  printed: boolean
  printedOn: string
  /** How the print went, when recorded at upload (CG, 14 Oct). */
  howWent: RunOutcome
  stop: { hours: number; units: number; note: string } | null
  stopWhy: string
  /** Already on this project (or earlier in this batch): when, or 'this batch'. */
  dupOf: string | null
  /** The plate already on the project this file is, when it is one. */
  dupPlate: string | null
  /** Stopped or failed: the parts that came off OK anyway, by name; the
   *  rest are marked failed (CG, 24 Oct). Empty: all failed. */
  okLabels: string[]
  /**
   * The same file again, on a plate that already has a print: is this ANOTHER
   * print of it? (CG, 24 Oct: a plate stopped part way, printed again clean,
   * dropped again -- and the clean print was silently not recorded.) Asked,
   * not guessed; defaulted to yes when the last print did not come off clean.
   */
  again: boolean
  /** Where each object goes, one per section (CG, 16 Oct). */
  sorts: SortGuess[]
  /** Some objects on the plate failed (your own work): which, and weights. */
  partial: boolean
  results: ObjectResult[]
  /** The plate's picture and when it was sliced, from the file. */
  extras: FileExtras
}

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
  /**
   * Every file dropped, each with its own review (CG, 15 Oct: "allow for
   * multiple files to be uploaded"). Nothing is written until a card is
   * added -- one at a time, or all at once.
   */
  const [pending, setPending] = useState<PendingFile[]>([])
  const [reading, setReading] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)
  /** What the last import did, a sentence per file. Without this an import
   *  is silent and reads as "nothing happened". */
  const [done, setDone] = useState<string[]>([])
  /** Errors shown IN the box, where the person is looking. */
  const [failed, setFailed] = useState<string | null>(null)
  const fail = (m: string | null) => {
    setFailed(m)
    setError(m)
  }
  // Offered only where printing belongs (stagePlan.canPrint). Before In
  // build a file is read in to price and plan -- never as printed.
  const printing = canPrint(detail.phase, detail.facts.kind)
  const mine = detail.facts.kind === 'inhouse'
  const fileRef = useRef<HTMLInputElement>(null)

  const patchOne = (key: string, p: Partial<PendingFile>) =>
    setPending((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)))

  async function pick(files: FileList | File[] | null | undefined) {
    const list = [...(files ?? [])]
    if (!list.length) return
    fail(null)
    setDone([])
    const errors: string[] = []
    const fresh: PendingFile[] = []
    for (const file of list) {
      setReading(list.length > 1 ? `Reading ${file.name} (${fresh.length + errors.length + 1} of ${list.length})…` : `Reading ${file.name}…`)
      try {
        const parsed = await parseSliceFile(file)
        const extras = await fileExtras(file)
        // Keep the file itself, not only what it said. Everything is worked
        // out BEFORE the card appears, so its buttons never act on a
        // half-read file (a 22 MB .bgcode takes a moment to pack).
        const bytes = new Uint8Array(await file.arrayBuffer())
        const packed = await packFile(bytes)
        const id = { fileName: parsed.fileName, estMinutes: parsed.totals.estMinutes, estGrams: parsed.totals.estGrams }
        const onProject = detail.slices.find((x) => sameSliceFile(x, id))
        const inBatch = [...pending, ...fresh].some((x) =>
          sameSliceFile({ fileName: x.read.fileName, estMinutes: x.read.totals.estMinutes, estGrams: x.read.totals.estGrams }, id),
        )
        const earlier: BatchPart[] = [...pending, ...fresh].flatMap((x) =>
          x.read.sections.flatMap((sec, j) => {
            const c = x.sorts[j]?.choice
            if (!c || c.kind !== 'new') return []
            const size = perCopyOf(sec)
            return [{ label: c.label, objectLabel: sec.label, grams: size.grams, minutes: size.minutes, fileName: x.read.fileName }]
          }),
        )
        fresh.push({
          sorts: guessSort(parsed.sections, parsed.fileName, detail.parts, earlier),
          partial: false,
          results: [],
          extras,
          key: `${file.name}-${crypto.randomUUID()}`,
          read: parsed,
          kept: packed,
          tooBig: packed ? null : tooBigNote(bytes.byteLength),
          // A file that names no machine, in a shop with one, was printed on
          // that one. A machine the shop does not own stays unmatched: a
          // blank is an open question, a guess looks answered.
          printerId:
            matchPrinter(ctx.printerRows, parsed.printerModel)?.id ??
            (!parsed.printerModel && ctx.printerRows.length === 1 ? ctx.printerRows[0].id : ''),
          materialId: matchMaterial(ctx.materials, parsed.totals.material)?.id ?? '',
          // Most files arrive AFTER the plate came off -- that is when people
          // remember to log them -- so the default is yes.
          printed: true,
          printedOn: todayISO(),
          howWent: 'success',
          stop: null,
          stopWhy: '',
          dupOf: onProject ? onProject.importedAt.slice(0, 10) : inBatch ? 'this batch' : null,
          dupPlate: onProject?.id ?? null,
          okLabels: [],
          again: (() => {
            if (!onProject) return false
            const before = detail.runs.filter((r) => r.sliceImportId === onProject.id)
            return before.length > 0 && before.every((r) => r.outcome !== 'success')
          })(),
        })
      } catch (e) {
        errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setReading(null)
    setPending((xs) => [...xs, ...fresh])
    if (errors.length) fail(errors.join(' · '))
    // Without this the same file cannot be picked twice in a row: the input
    // fires change only when the value differs.
    if (fileRef.current) fileRef.current.value = ''
  }

  function discard(key: string) {
    setPending((xs) => xs.filter((x) => x.key !== key))
    setDragging(false)
  }

  /** The part an object of a card goes on, by name. */
  function targetLabel(p: PendingFile, j: number): string {
    const c = p.sorts[j]?.choice
    if (!c) return p.read.sections[j]?.label ?? ''
    return c.kind === 'part' ? (detail.parts.find((x) => x.id === c.partId)?.label ?? '') : c.label
  }

  /** The same file again, said to be the same print: nothing to record. */
  function droppedAgain(p: PendingFile): boolean {
    return !!p.dupPlate && !p.again && detail.runs.some((r) => r.sliceImportId === p.dupPlate)
  }

  /** Why a card cannot be added yet, or null when it can. */
  function blocker(p: PendingFile): string | null {
    if (p.sorts.some((g) => g.choice.kind === 'new' && !g.choice.label.trim())) return 'Name the new part above'
    const printedNow = printing && p.printed && !droppedAgain(p)
    if (printedNow && !p.printerId) return 'Pick the machine above to record the print'
    if (printedNow && p.howWent !== 'success' && !p.stop) return 'Say how long it ran and what it weighs, above'
    return null
  }

  /** Write one card: the import, and the print if it already happened. */
  async function addOne(p: PendingFile, recordedNow: Set<string>): Promise<{ text: string; parts: number }> {
    const { read, kept, printerId, materialId, howWent, stop, stopWhy } = p
    const printedNow = printing && p.printed && !droppedAgain(p)
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
      progress: read.progress,
      thumbnail: p.extras.thumbnail,
      slicedAt: p.extras.slicedAt,
      sections: read.sections.map((sec, j) => ({
        label: sec.label,
        qty: sec.qty,
        estMinutes: sec.estMinutes,
        estGrams: sec.estGrams,
        material: sec.material,
        assign: p.sorts[j] ? toAssign(p.sorts[j].choice) : null,
      })),
    })
    let recorded: string | null = null
    // A duplicate is not a second print -- unless you said it printed again
    // and nothing was recorded from it yet.
    // `detail` is from before this batch, so a file recorded earlier in the
    // same batch is remembered here -- the same file dropped twice is one print.
    const alreadyRecorded =
      !!res.duplicateOf &&
      (recordedNow.has(res.importId) || (!p.again && detail.runs.some((r) => r.sliceImportId === res.importId)))
    if (alreadyRecorded) {
      recorded = 'Its print was already recorded, so nothing was counted twice — use “Print it again” on the plate if it really printed twice.'
    } else if (printedNow && printerId) {
      const partial = mine && p.partial && p.results.some((r) => r.failed)
      const grams = partial
        ? Math.round(gramsUsed(p.results))
        : read.totals.estGrams == null
          ? 0
          : Math.round(read.totals.estGrams)
      const hours = read.totals.estMinutes == null ? 0 : Math.round((read.totals.estMinutes / 60) * 100) / 100
      const clean = howWent === 'success'
      const usedG = clean ? grams : Math.round(stop?.units ?? grams)
      const usedH = clean ? hours : (stop?.hours ?? hours)
      const why = stopWhy.trim() || (howWent === 'cancelled' ? 'Stopped part way.' : 'The plate failed.')
      const runInput: PrintRunInput = {
        printerId,
        materialId: materialId || null,
        unitsUsed: materialId ? usedG : 0,
        hours: usedH,
        outcome: howWent,
        failureReason: clean ? (partial ? stopWhy.trim() || 'Some objects failed.' : null) : why,
        note: clean ? `From ${read.fileName}` : (stop?.note ?? `From ${read.fileName}`),
        startedAt: p.printedOn || todayISO(),
        sliceImportId: res.importId,
      }
      const runId = await recordPrintRun(ctx.shop.id, detail.jobId, ctx.profile.id, runInput)
      recordedNow.add(res.importId)
      // Your own work: what came off, piece by piece, each at its share of
      // the print -- ready to send to the shelf or into an assembly.
      if (mine) {
        const saved = (await listSliceImports(ctx.shop.id, detail.jobId)).find((x) => x.id === res.importId)
        const ids = saved ? objectsOf(saved, []).map((o) => o.sectionId) : []
        const objs = objectsOfRead(read, p.sorts, detail.parts).map((o, k) => ({ ...o, sectionId: ids[k] ?? null }))
        const rs = partial ? p.results.map((r, k) => ({ ...r, sectionId: ids[k] ?? null, label: objs[k]?.label ?? r.label })) : null
        await recordMadeItems(ctx.shop.id, detail.jobId, runId, madeFromPrint(ctx, { ...runInput, unitsUsed: usedG }, objs, rs))
      }
      // The plate came off: each part on it gains the copies the plate
      // holds. Or it did not, and those copies fail with it.
      let marked: number
      if (!clean && !mine && p.okLabels.length) {
        // Some of it came off: those parts printed, the rest failed.
        const saved = (await listSliceImports(ctx.shop.id, detail.jobId)).find((x) => x.id === res.importId)
        const okIds = (saved?.sections ?? [])
          .filter((_, j) => p.okLabels.includes(targetLabel(p, j)))
          .map((sec) => sec.partId)
          .filter((x): x is string => !!x)
        const r = await markPlateParts(ctx.shop.id, detail.jobId, ctx.profile.id, res.importId, runId, okIds, why)
        marked = r.failed
      } else
        marked = clean
          ? await markPlatePrinted(ctx.shop.id, detail.jobId, ctx.profile.id, res.importId, runId)
          : await markPlateFailed(ctx.shop.id, detail.jobId, ctx.profile.id, res.importId, runId, why)
      const machine = ctx.printerRows.find((x) => x.id === printerId)?.name ?? 'the machine'
      recorded =
        `Recorded as ${clean ? 'printed' : howWent === 'cancelled' ? 'stopped part way' : 'failed'} on ${machine}: ${
          clean ? (hrs(read.totals.estMinutes) ?? '0h') : fmtHours(usedH)
        }` +
        (materialId ? `, ${usedG} g off the shelf` : ', no material matched so nothing came off the shelf') +
        (marked ? `, ${marked} part${marked === 1 ? '' : 's'} marked ${clean ? 'printed' : 'failed'}` : '') +
        '.'
    }
    const bits: string[] = []
    if (res.duplicateOf) bits.push(`already on this project since ${res.duplicateOf.slice(0, 10)}, not added again`)
    if (res.partsAdded) bits.push(`${res.partsAdded} part${res.partsAdded === 1 ? '' : 's'} added`)
    if (res.partsMatched) bits.push(`${res.partsMatched} already on the sheet, estimate updated`)
    return {
      text:
        `${read.fileName} — ${bits.join(' · ') || 'read, nothing to add'}${kept ? ', file kept' : ''}. ` +
        (recorded ?? 'It is listed under “Plates” below; record it when it comes off the machine and the filament comes off the shelf.'),
      parts: res.partsAdded + res.partsMatched,
    }
  }

  /** Add these cards, in the order they were dropped, then reload once. */
  async function add(cards: PendingFile[]) {
    setSaving(true)
    fail(null)
    const notes: string[] = []
    let parts = 0
    const recordedNow = new Set<string>()
    try {
      for (const p of cards) {
        const r = await addOne(p, recordedNow)
        notes.push(r.text)
        parts += r.parts
        setPending((xs) => xs.filter((x) => x.key !== p.key))
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e))
    } finally {
      setDone(notes)
      if (notes.length) {
        onImported(parts)
        await onChanged()
      }
      setSaving(false)
    }
  }

  const hrs = (m: number | null) =>
    m == null ? null : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
  const ready = pending.filter((p) => !blocker(p))

  return (
    <div style={{ marginTop: 12 }}>
      {failed && (
        <div className="attn crit" role="alert" style={{ marginTop: 0, marginBottom: 10 }}>
          <span>That file was not imported: {failed}</span>
        </div>
      )}
      {done.map((d) => (
        <div key={d} className="landed-note hint" style={{ marginTop: 0, marginBottom: 6, color: 'var(--ok)' }}>
          {d}
        </div>
      ))}

      {/* A label wrapping a visually-hidden input, so the whole box is the
          control: clickable, focusable, and announced as a file input. */}
      <label
        // Once the sheet has parts, importing is the exception, so the box
        // shrinks to one line and stops pushing the parts down the page.
        className={`drop ${dragging ? 'over' : ''} ${detail.parts.length > 0 ? 'compact' : ''}`.trim()}
        htmlFor="slice-file"
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void pick(e.dataTransfer.files)
        }}
      >
        <span className="dropicon">⤓</span>
        <span className="drop-title">
          {reading ??
            (dragging
              ? 'Drop them'
              : detail.parts.length > 0
                ? 'Add plates — drop sliced files, or click'
                : 'Drop sliced files here, or click to choose — one or several')}
        </span>
        <span className="drop-sub">
          .gcode.3mf from Bambu Studio or Orca · .gcode or .bgcode from PrusaSlicer
        </span>
        <input
          id="slice-file"
          ref={fileRef}
          type="file"
          multiple
          // A fixed aria-label keeps the control's name stable while the
          // visible label changes mid-drag.
          aria-label="Import sliced files"
          accept={SLICE_ACCEPT}
          disabled={busy || saving || !!reading}
          onChange={(e) => void pick(e.target.files)}
          // Visually hidden, NOT disabled for the pointer.
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
        />
      </label>
      {detail.parts.length === 0 && pending.length === 0 && (
        <div className="hint" style={{ marginTop: 6 }}>
          Guma reads the objects on each plate, the machine and the filament, and shows you before
          writing anything. You choose whether each has already been printed; if not, it waits as an
          estimate until you record it.
        </div>
      )}

      {pending.length > 1 && (
        <div className="pane" style={{ marginTop: 10, marginBottom: 0, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 200, fontSize: 12 }}>
            <b>{pending.length} files read.</b> Check each below — machine, material, and whether it printed — then add
            them together. They are added in this order, so a failed plate before its reprint stays in that order.
          </span>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || saving || ready.length !== pending.length}
            title={ready.length !== pending.length ? 'One of the files below still needs an answer.' : undefined}
            onClick={() => void add(pending)}
          >
            {saving ? 'Adding…' : ready.length !== pending.length ? `${pending.length - ready.length} still need an answer` : `Add all ${pending.length}`}
          </button>
          <button type="button" className="btn sm" disabled={saving} onClick={() => setPending([])}>
            Discard all
          </button>
        </div>
      )}

      {pending.map((p, i) => {
        const { read } = p
        const printedNow = printing && p.printed && !droppedAgain(p)
        // The first card keeps the plain ids the page has always had.
        const sfx = i === 0 ? '' : `-${i + 1}`
        const block = blocker(p)
        return (
          <div className="pane" style={{ marginTop: 10 }} key={p.key} role="group" aria-label={`Review ${read.fileName}`}>
            <div className="sechead">
              {p.extras.thumbnail && <img className="platethumb" src={p.extras.thumbnail} alt={`Preview of ${read.fileName}`} />}
              <h4>{read.fileName}</h4>
              {p.extras.slicedAt && <span className="sub">sliced {p.extras.slicedAt.slice(0, 10)}</span>}
              <span className="sub">
                {read.totals.sections} section{read.totals.sections === 1 ? '' : 's'} ·{' '}
                {read.totals.units} cop{read.totals.units === 1 ? 'y' : 'ies'}
                {read.totals.estGrams != null && ` · ~${read.totals.estGrams} g`}
                {read.totals.estMinutes != null && ` · ~${hrs(read.totals.estMinutes)}`}
              </span>
            </div>
            {p.dupOf &&
              (() => {
                const before = p.dupPlate ? detail.runs.filter((r) => r.sliceImportId === p.dupPlate) : []
                if (p.dupOf === 'this batch' || !before.length)
                  return (
                    <div className="attn warn" role="note" style={{ marginTop: 0, marginBottom: 8 }}>
                      <span>
                        {p.dupOf === 'this batch'
                          ? 'The same file is already in this batch — it will be counted once.'
                          : `This file is already on the project (imported ${p.dupOf}) and nothing has been recorded from it yet — recording now records its first print.`}
                      </span>
                    </div>
                  )
                const said = (r: PrintRunRow) =>
                  `${(r.startedAt ?? '').slice(0, 10)}, ${r.outcome === 'success' ? 'came off clean' : r.outcome === 'cancelled' ? 'stopped part way' : 'failed'}`
                return (
                  <div className="attn warn" role="group" aria-label="Another print of this plate?" style={{ marginTop: 0, marginBottom: 8, display: 'block' }}>
                    <b>This plate is already on the project</b>, with {before.length} print
                    {before.length === 1 ? '' : 's'} recorded: {before.map(said).join('; ')}. Is this another print of it?
                    <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 12, flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="radio" name={`again-${p.key}`} checked={p.again} onChange={() => patchOne(p.key, { again: true, printed: true })} />
                        Yes — I printed it again; record this print too
                      </label>
                      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="radio" name={`again-${p.key}`} checked={!p.again} onChange={() => patchOne(p.key, { again: false })} />
                        No — same print, the file was just dropped again
                      </label>
                    </div>
                  </div>
                )
              })()}

            <div className="sheetwrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '30%' }}>Object in the file</th>
                    <th className="r">Copies</th>
                    <th className="r">Est. grams</th>
                    <th className="r">Est. time</th>
                    <th style={{ width: '38%' }}>Goes on the build sheet as</th>
                  </tr>
                </thead>
                <tbody>
                  {read.sections.map((sec, j) => (
                    <tr key={`${sec.label}-${j}`}>
                      <td>
                        <span className="pn">{sec.label}</span>
                      </td>
                      <td className="r">{sec.qty}</td>
                      <td className="r">{sec.estGrams ?? '—'}</td>
                      <td className="r">{hrs(sec.estMinutes) ?? '—'}</td>
                      <td>
                        <SortPick
                          id={`sort${sfx}-${j}`}
                          objectLabel={sec.label}
                          fileName={read.sections.length === 1 ? read.fileName : null}
                          guess={p.sorts[j]}
                          parts={detail.parts}
                          joins={pending
                            .slice(0, i)
                            .flatMap((x) => x.sorts.map((g) => g.choice))
                            .flatMap((c) => (c.kind === 'new' ? [c.label] : []))}
                          onChange={(g) =>
                            patchOne(p.key, { sorts: p.sorts.map((x, k) => (k === j ? g : x)) })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="btnrow" style={{ marginTop: 10, alignItems: 'flex-end' }}>
              <div className="fld" style={{ margin: 0, flex: 1, minWidth: 180 }}>
                <label className="lbl" htmlFor={`slice-printer${sfx}`}>
                  Machine{read.printerModel ? ` — file says “${read.printerModel}”` : ''}
                </label>
                <select id={`slice-printer${sfx}`} value={p.printerId} onChange={(e) => patchOne(p.key, { printerId: e.target.value })}>
                  <option value="">Not matched</option>
                  {ctx.printerRows.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.model ? ` · ${x.model}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="fld" style={{ margin: 0, flex: 1, minWidth: 180 }}>
                <label className="lbl" htmlFor={`slice-material${sfx}`}>
                  Material{read.totals.material ? ` — file says “${read.totals.material}”` : ''}
                </label>
                <select id={`slice-material${sfx}`} value={p.materialId} onChange={(e) => patchOne(p.key, { materialId: e.target.value })}>
                  <option value="">Not matched</option>
                  {ctx.materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {p.tooBig && (
              <div className="hint" style={{ marginTop: 6, color: 'var(--warn)' }}>
                {p.tooBig}
              </div>
            )}
            {p.kept && (
              <div className="hint" style={{ marginTop: 6 }}>
                The file itself will be kept with the project — {mb(p.kept.byteSize)}, stored as {mb(p.kept.storedSize)}.
                Reprinting in eight months means reprinting THIS file, not one with the same name.
              </div>
            )}
            {read.notes.map((n) => (
              <div className="hint" key={n} style={{ marginTop: 6 }}>
                {n}
              </div>
            ))}

            {printing && !droppedAgain(p) && (
              <div className="btnrow" style={{ marginTop: 10, alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                  <input type="checkbox" checked={printedNow} onChange={(e) => patchOne(p.key, { printed: e.target.checked })} />
                  Already printed — record it now
                </label>
                {printedNow && (
                  <input
                    type="date"
                    aria-label="Printed on"
                    value={p.printedOn}
                    onChange={(e) => patchOne(p.key, { printedOn: e.target.value })}
                    style={{ width: 150 }}
                  />
                )}
                {printedNow && (
                  <select
                    aria-label="How it went"
                    style={{ width: 'auto' }}
                    value={p.partial ? 'partial' : p.howWent}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === 'partial')
                        patchOne(p.key, {
                          howWent: 'success',
                          partial: true,
                          stop: null,
                          results: objectsOfRead(read, p.sorts, detail.parts).map((o) => ({ ...o, failed: false, weighed: null })),
                        })
                      else patchOne(p.key, { howWent: v as RunOutcome, partial: false, stop: null })
                    }}
                  >
                    <option value="success">Came off clean</option>
                    {mine && objectsOfRead(read, p.sorts, detail.parts).length > 1 && (
                      <option value="partial">Some objects failed</option>
                    )}
                    <option value="cancelled">Stopped part way</option>
                    <option value="failed">Failed</option>
                  </select>
                )}
              </div>
            )}
            {printedNow && p.howWent !== 'success' && !mine &&
              (() => {
                const labels = [...new Set(read.sections.map((_, j) => targetLabel(p, j)).filter(Boolean))]
                return labels.length > 1 ? (
                  <CameOffOk
                    id={`imp-ok${sfx}`}
                    labels={labels}
                    ok={p.okLabels}
                    onChange={(okLabels) => patchOne(p.key, { okLabels })}
                  />
                ) : null
              })()}
            {printedNow && p.partial && (
              <>
                <ObjectResults
                  id={`imp-obj${sfx}`}
                  results={p.results}
                  unit={ctx.materials.find((m) => m.id === p.materialId)?.unit ?? 'g'}
                  onChange={(r) => patchOne(p.key, { results: r })}
                />
                <div className="fld" style={{ marginTop: 8, marginBottom: 0 }}>
                  <label className="lbl" htmlFor={`imp-why${sfx}`}>
                    What went wrong
                  </label>
                  <input
                    id={`imp-why${sfx}`}
                    value={p.stopWhy}
                    placeholder="Knocked off the plate, warped corner…"
                    onChange={(e) => patchOne(p.key, { stopWhy: e.target.value })}
                  />
                </div>
              </>
            )}
            {printedNow && p.howWent !== 'success' && (
              <>
                <div className="fld" style={{ marginTop: 8, marginBottom: 0 }}>
                  <label className="lbl" htmlFor={`imp-why${sfx}`}>
                    What went wrong
                  </label>
                  <input
                    id={`imp-why${sfx}`}
                    value={p.stopWhy}
                    placeholder="Ghost printing, clog, warped off the plate…"
                    onChange={(e) => patchOne(p.key, { stopWhy: e.target.value })}
                  />
                </div>
                <StoppedPrint
                  ctx={ctx}
                  slice={{
                    id: null,
                    fileName: read.fileName,
                    estMinutes: read.totals.estMinutes,
                    estGrams: read.totals.estGrams,
                    progress: read.progress,
                    keptBytes: null,
                  }}
                  unit={ctx.materials.find((m) => m.id === p.materialId)?.unit ?? 'g'}
                  onApply={(h, u, note) => patchOne(p.key, { stop: { hours: h, units: u, note } })}
                />
              </>
            )}
            {printedNow && p.howWent === 'success' && (
              <div className="hint" style={{ marginTop: 4 }}>
                {p.printerId
                  ? `Writes the run from the file: ${hrs(read.totals.estMinutes) ?? 'no time in the file'} on the machine` +
                    (p.materialId
                      ? `, ${read.totals.estGrams == null ? 0 : Math.round(read.totals.estGrams)} g off the shelf, `
                      : ', no material matched — pick one or nothing comes off the shelf, ') +
                    'plate parts marked printed. If it stopped part way, choose that above; to fix it later, use “correct” on the print under its plate.'
                  : 'Pick the machine it printed on — a print run needs one.'}
              </div>
            )}

            <div className="btnrow" style={{ marginTop: 10 }}>
              <button
                type="button"
                className={`btn sm ${pending.length > 1 ? '' : 'primary'}`.trim()}
                disabled={busy || saving || !!block}
                onClick={() => void add([p])}
              >
                {block ??
                  (printedNow
                    ? p.howWent === 'success'
                      ? `Add${pending.length > 1 ? ' this one' : ''} to the build sheet and record the print`
                      : `Add${pending.length > 1 ? ' this one' : ''} to the build sheet and record where it stopped`
                    : `Add ${read.totals.sections} section${read.totals.sections === 1 ? '' : 's'} to the build sheet`)}
              </button>
              <button type="button" className="btn sm" disabled={saving} onClick={() => discard(p.key)}>
                Discard
              </button>
            </div>
          </div>
        )
      })}
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
  /** Removing a plate takes its prints with it unless this is unticked. */
  const [removePrints, setRemovePrints] = useState(true)
  const [rereadMsg, setRereadMsg] = useState<{ id: string; text: string } | null>(null)
  /**
   * The recorded print being corrected, when the form is open for that
   * (CG, 14 Oct: a plate recorded as clean had stopped at 15 of 16h 26m,
   * and the only way to fix it was to remove it and record it again).
   */
  const [correcting, setCorrecting] = useState<PrintRunRow | null>(null)
  /** The plate whose objects are being sorted onto parts, and the draft. */
  const [sorting, setSorting] = useState<string | null>(null)
  /** Your own work: what came off, object by object (CG, 21 Oct). */
  const mine = detail.facts.kind === 'inhouse'
  /**
   * Pictures and sliced dates for plates imported before Guma read them
   * (CG, 22 Oct): each kept file is read once, quietly, one at a time.
   */
  const extrasTried = useRef(new Set<string>())
  useEffect(() => {
    const todo = detail.slices.filter(
      (x) => !x.thumbnail && !x.slicedAt && x.keptBytes != null && !extrasTried.current.has(x.id),
    )
    if (!todo.length) return
    let live = true
    void (async () => {
      let found = 0
      for (const x of todo) {
        if (!live) return
        extrasTried.current.add(x.id)
        try {
          const row = await sliceFileContent(ctx.shop.id, x.id)
          if (!row) continue
          const bytes = await unpackFile(row.content)
          const ex = await fileExtras(new File([bytes as unknown as BlobPart], x.fileName))
          if (ex.thumbnail || ex.slicedAt) {
            await setSliceExtras(ctx.shop.id, x.id, ex.thumbnail, ex.slicedAt)
            found++
          }
        } catch {
          // A picture is a nicety; leave the plate as it is.
        }
      }
      if (live && found) await onChanged()
    })()
    return () => {
      live = false
    }
  }, [detail.slices, ctx.shop.id, onChanged])
  const [results, setResults] = useState<ObjectResult[]>([])
  /** A stopped or failed plate: the parts that came off OK anyway, by name. */
  const [okParts, setOkParts] = useState<string[]>([])
  const [sortDraft, setSortDraft] = useState<Record<string, SortGuess>>({})
  const [sortMsg, setSortMsg] = useState<{ id: string; text: string } | null>(null)

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

  /**
   * Re-read a kept file with the current reader. The fresh import matches
   * the same parts by name; the old import is dropped only if no print was
   * recorded from it (a recorded print stays linked to what it was
   * recorded from).
   */
  async function reread(importId: string, fileName: string, runCount: number) {
    setSaving(true)
    setError(null)
    setRereadMsg(null)
    try {
      const row = await sliceFileContent(ctx.shop.id, importId)
      if (!row) throw new Error('That file was not kept — import it again.')
      const bytes = await unpackFile(row.content)
      const file = new File([bytes as unknown as BlobPart], fileName)
      const parsed = await parseSliceFile(file)
      if (parsed.totals.estMinutes == null && parsed.totals.estGrams == null) {
        throw new Error(
          'Read again — still no print time or filament in it. Export the plate sliced file (.gcode.3mf) and import that.',
        )
      }
      if (runCount === 0) await deleteSliceImport(ctx.shop.id, importId)
      await importSlice(ctx.shop.id, detail.jobId, ctx.profile.id, {
        file: await packFile(bytes),
        fileName: parsed.fileName,
        kind: parsed.kind,
        printerModel: parsed.printerModel,
        printerId:
          matchPrinter(ctx.printerRows, parsed.printerModel)?.id ??
          detail.slices.find((x) => x.id === importId)?.printerId ??
          null,
        materialText: parsed.totals.material,
        materialId:
          matchMaterial(ctx.materials, parsed.totals.material)?.id ??
          detail.slices.find((x) => x.id === importId)?.materialId ??
          null,
        estMinutes: parsed.totals.estMinutes,
        estGrams: parsed.totals.estGrams,
        notes: parsed.notes,
        progress: parsed.progress,
        sections: parsed.sections.map((sec) => ({
          label: sec.label,
          qty: sec.qty,
          estMinutes: sec.estMinutes,
          estGrams: sec.estGrams,
          material: sec.material,
        })),
      })
      await onChanged()
    } catch (e) {
      setRereadMsg({ id: importId, text: e instanceof Error ? e.message : String(e) })
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /**
   * Remove a plate, and make the build sheet match (CG, 23 Oct): its prints
   * (unless kept) are undone -- copies back to not printed, filament back on
   * the shelf -- and the parts only it made come off. What stays says why,
   * in the confirm box, from the same plateRemoval() the box showed.
   */
  async function removeAll(importIds: string[], runIds: string[], withPrints: boolean, fileName: string) {
    setSaving(true)
    setError(null)
    try {
      const plan = plateRemoval(detail.parts, importIds, runIds, withPrints)
      if (withPrints) for (const r of runIds) await deletePrintRun(ctx.shop.id, r, true)
      for (const importId of importIds) await deleteSliceImport(ctx.shop.id, importId)
      for (const p of plan.remove)
        await deletePart(ctx.shop.id, p.id, ctx.profile.id, `Its plate ${fileName} was removed, and nothing else made or marked it.`)
      setRemoving(null)
      setRemovePrints(true)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /**
   * Move the objects whose part changed (CG, 16 Oct). Each one takes the
   * copies its prints marked with it; the same object in a re-upload of the
   * same file goes the same way.
   */
  async function saveSort(g: ReturnType<typeof groupSliceFiles>[number]) {
    setSaving(true)
    setError(null)
    setSortMsg(null)
    const said: string[] = []
    try {
      const first = detail.slices.find((x) => x.id === g.first.id)
      const left = new Set<string>()
      for (const sec of first?.sections ?? []) {
        const pick = sortDraft[sec.id]?.choice
        if (!pick) continue
        if (pick.kind === 'part' && pick.partId === sec.partId) continue
        const was = detail.parts.find((p) => p.id === sec.partId)?.label ?? 'no part'
        const res = await moveSliceSection(ctx.shop.id, detail.jobId, ctx.profile.id, sec.id, toAssign(pick))
        // The same object on a re-upload of this file follows it.
        for (const id of g.ids.slice(1))
          for (const twin of detail.slices.find((x) => x.id === id)?.sections ?? [])
            if (twin.label === sec.label && twin.partId === sec.partId)
              await moveSliceSection(ctx.shop.id, detail.jobId, ctx.profile.id, twin.id, { partId: res.partId })
        if (sec.partId) left.add(sec.partId)
        const name =
          pick.kind === 'part' ? (detail.parts.find((p) => p.id === pick.partId)?.label ?? 'that part') : pick.label
        said.push(
          `${sec.label}: ${was} → ${name}` +
            (res.moved ? ` (${res.moved} cop${res.moved === 1 ? 'y' : 'ies'} moved with it)` : '') +
            (res.unplaced ? ` — ${res.unplaced} print${res.unplaced === 1 ? '' : 's'} could not mark a copy there: it has none left to mark; add a copy on the build sheet` : ''),
        )
      }
      // A part no plate prints any more may not be a part at all.
      const moved = new Set((first?.sections ?? []).filter((x) => sortDraft[x.id]).map((x) => x.id))
      const orphans = [...left].filter(
        (pid) => !detail.slices.some((x) => x.sections.some((sec) => sec.partId === pid && !moved.has(sec.id) && !g.ids.slice(1).includes(x.id))),
      )
      for (const pid of orphans) {
        const p = detail.parts.find((x) => x.id === pid)
        if (p) said.push(`${p.label} has no plate now — remove it on the build sheet if it is not a real part.`)
      }
      setSorting(null)
      setSortDraft({})
      setSortMsg({ id: g.first.id, text: said.length ? said.join(' · ') : 'Nothing changed.' })
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (detail.slices.length === 0) return null

  const groups = newestFirst(groupSliceFiles(detail.slices, detail.runs), detail.runs)
  /** Plates with numbers, a machine to put them on, and nothing recorded. */
  const ready = groups.filter(
    (g) => !g.recorded && (g.first.estGrams != null || g.first.estMinutes != null) && machineFor(g, ctx.printers) != null,
  )

  /**
   * Every plate not recorded yet, from each file's own numbers. This was
   * "From the sliced files, Record all" further down the page; the two
   * lists are one now (CG, 8 Oct), so a plate has one place to be recorded.
   */
  async function recordAll() {
    setSaving(true)
    setError(null)
    try {
      for (const g of ready) {
        const runId = await recordPrintRun(ctx.shop.id, detail.jobId, ctx.profile.id, {
          printerId: machineFor(g, ctx.printers) as string,
          materialId: g.first.materialId,
          unitsUsed: g.estGrams ?? 0,
          hours: g.estHours ?? 0,
          outcome: 'success',
          failureReason: null,
          note: `From ${g.first.fileName}`,
          startedAt: todayISO(),
          sliceImportId: g.first.id,
        })
        await markPlatePrinted(ctx.shop.id, detail.jobId, ctx.profile.id, g.first.id, runId)
        if (mine) {
          const slice = detail.slices.find((x) => x.id === g.first.id)
          if (slice)
            await recordMadeItems(
              ctx.shop.id,
              detail.jobId,
              runId,
              madeFromPrint(
                ctx,
                { printerId: machineFor(g, ctx.printers) as string, materialId: g.first.materialId, unitsUsed: g.estGrams ?? 0, hours: g.estHours ?? 0, outcome: 'success', failureReason: null, note: null, startedAt: todayISO() },
                objectsOf(slice, detail.parts),
                null,
              ),
            )
        }
      }
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const hrs = (m: number | null) =>
    m == null ? null : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`

  function openCorrect(s: (typeof detail.slices)[number], run: PrintRunRow, outcome?: RunOutcome) {
    setError(null)
    setResults(mine ? objectsOf(s, detail.parts).map((o) => ({ ...o, failed: false, weighed: null })) : [])
    setOpenId(s.id)
    setCorrecting(run)
    setMarkParts(true)
    setForm({
      printerId: run.printerId ?? '',
      materialId: run.materialId,
      unitsUsed: run.unitsUsed ?? 0,
      hours: run.hours ?? 0,
      outcome: outcome ?? run.outcome ?? 'success',
      failureReason: run.failureReason,
      note: run.note,
      startedAt: run.startedAt,
      sliceImportId: s.id,
    })
  }

  function open(s: (typeof detail.slices)[number]) {
    setError(null)
    setResults(mine ? objectsOf(s, detail.parts).map((o) => ({ ...o, failed: false, weighed: null })) : [])
    setCorrecting(null)
    setOpenId(s.id)
    setForm({
      // A run needs a machine. The import may not have matched one, in
      // which case the select opens empty and the button stays disabled
      // rather than picking the first printer in the list for you.
      printerId: s.printerId ?? (ctx.printers.length === 1 ? ctx.printers[0].id : ''),
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
    const slice = detail.slices.find((x) => x.id === importId)
    if (!slice) return []
    const ids = new Set(slice.sections.map((sec) => sec.partId).filter((x): x is string => !!x))
    return detail.parts.filter((p) => ids.has(p.id) && awaitingPrint(p.status)).map((p) => p.id)
  }

  async function record() {
    if (!form) return
    setSaving(true)
    setError(null)
    try {
      const slice = form.sliceImportId ? detail.slices.find((x) => x.id === form.sliceImportId) : null
      const made = (runInput: PrintRunInput) =>
        mine && slice ? madeFromPrint(ctx, runInput, objectsOf(slice, detail.parts), results) : null
      if (correcting) {
        // What it made is rewritten first: if any of it is already placed
        // that refuses, and the print is left as it was.
        const items = made({ ...form, printerId: correcting.printerId ?? form.printerId, materialId: correcting.materialId })
        if (items) await recordMadeItems(ctx.shop.id, detail.jobId, correcting.id, items)
        await correctPrintRun(
          ctx.shop.id,
          correcting.id,
          ctx.profile.id,
          {
            unitsUsed: form.unitsUsed,
            hours: form.hours,
            outcome: form.outcome,
            failureReason: form.failureReason,
            note: form.note,
          },
          markParts && form.outcome !== 'success',
        )
        setCorrecting(null)
        setOpenId(null)
        setForm(null)
        await onChanged()
        return
      }
      const runId = await recordPrintRun(ctx.shop.id, detail.jobId, ctx.profile.id, form)
      const items = made(form)
      if (items) await recordMadeItems(ctx.shop.id, detail.jobId, runId, items)
      // The plate came off, so every object on it came off -- or it failed,
      // and every copy it was printing failed with it, so the reprint
      // workflow starts on the build sheet (CG, 13 Oct). Either way the
      // copies remember this print, so removing it can put them back.
      if (markParts && form.sliceImportId) {
        const plate = plateParts(form.sliceImportId)
        const okIds = plate.filter((x) => okParts.includes(x.label)).map((x) => x.id)
        if (form.outcome === 'success')
          await markPlatePrinted(ctx.shop.id, detail.jobId, ctx.profile.id, form.sliceImportId, runId)
        else if (!mine && okIds.length)
          await markPlateParts(
            ctx.shop.id,
            detail.jobId,
            ctx.profile.id,
            form.sliceImportId,
            runId,
            okIds,
            form.failureReason || (form.outcome === 'cancelled' ? 'Cancelled part way.' : 'The plate failed.'),
          )
        else
          await markPlateFailed(
            ctx.shop.id,
            detail.jobId,
            ctx.profile.id,
            form.sliceImportId,
            runId,
            form.failureReason || (form.outcome === 'cancelled' ? 'Cancelled part way.' : 'The plate failed.'),
          )
      }
      setOpenId(null)
      setForm(null)
      setOkParts([])
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** The parts a plate makes, each once, by name. */
  function plateParts(importId: string): { id: string; label: string }[] {
    const ids = [...new Set((detail.slices.find((x) => x.id === importId)?.sections ?? []).map((sec) => sec.partId).filter(Boolean))]
    return ids.flatMap((id) => {
      const part = detail.parts.find((x) => x.id === id)
      return part ? [{ id: part.id, label: part.label }] : []
    })
  }

  const unit = ctx.materials.find((m) => m.id === form?.materialId)?.unit ?? 'g'

  return (
    <div style={{ marginTop: 14 }}>
      <div className="sechead">
        <h4>Plates</h4>
        <span className="sub">
          {mine
            ? 'One per sliced file, newest print first. Record a plate when it comes off: the filament comes off the shelf and what came off goes to Made below.'
            : 'One per sliced file. When a plate comes off the bed, record it: its copies are marked printed and the filament comes off the shelf.'}
        </span>
        {canPrint(detail.phase, detail.facts.kind) && ready.length > 1 && (
          <button
            type="button"
            className="btn sm primary"
            style={{ marginLeft: 'auto' }}
            disabled={busy || saving}
            onClick={() => void recordAll()}
          >
            Record all {ready.length}
          </button>
        )}
      </div>

      <div className="platelist" role="region" aria-label="Plates">
      {groups.map((g) => {
        // One row per FILE: the same file uploaded three times is one plate
        // (lib/fromFiles.ts), recorded against its first import.
        const s = g.first
        const runs = g.runs
        const used = runs.reduce((a, r) => a + (r.unitsUsed ?? 0), 0)
        const hours = runs.reduce((a, r) => a + (r.hours ?? 0), 0)
        const failed = runs.filter((r) => r.outcome !== 'success').length
        // A failed copy's replacement file says whose it is (CG, 9 Oct):
        // it is not a new plate of work, it is that copy's second go.
        // Or it printed a copy that had failed -- a reprint, whether or not
        // the file was named as its replacement (CG, 15 Oct).
        const runIds = new Set(runs.map((r) => r.id))
        const fixes = detail.parts.flatMap((p) => {
          const cs = new Set<number>()
          for (const h of p.history) {
            if (h.sliceImportId && g.ids.includes(h.sliceImportId)) (h.copies ?? []).forEach((c) => cs.add(c))
            if (h.runId && runIds.has(h.runId) && h.fromStatus === 'reprint') (h.copies ?? []).forEach((c) => cs.add(c))
          }
          return cs.size ? [`${p.label}, copy ${[...cs].sort((a, b) => a - b).join(' & ')}`] : []
        })
        // What this plate makes, by name -- the thread back to the build sheet.
        const makes = (() => {
          const by = new Map<string, number>()
          for (const id of g.ids)
            for (const sec of detail.slices.find((x) => x.id === id)?.sections ?? []) {
              const label = detail.parts.find((p) => p.id === sec.partId)?.label ?? sec.label
              if (id === g.first.id) by.set(label, (by.get(label) ?? 0) + Math.max(1, sec.qty ?? 1))
            }
          return [...by].map(([l, q]) => (q > 1 ? `${l} ×${q}` : l))
        })()
        const latest = runs[0]
        const status = !latest
          ? { cls: '', text: 'not printed yet' }
          : latest.outcome === 'success'
            ? { cls: 'ok', text: runs.length > 1 ? `printed · ${runs.length} prints` : 'printed' }
            : { cls: 'crit', text: latest.outcome === 'failed' ? 'failed' : 'stopped part way' }
        return (
          <div className="plate" key={s.id} data-testid={`plate-${s.id}`}>
            <div className="platehead">
              {/* The slicer's own picture of the plate: the quickest way to
                  tell two plates apart (CG, 22 Oct). */}
              {s.thumbnail ? (
                <img className="platethumb" src={s.thumbnail} alt={`Preview of ${s.fileName}`} />
              ) : (
                <div className="platethumb none" aria-hidden="true">
                  no preview
                </div>
              )}
              <div className="platename">
                {/* Named for what it makes: two plates can share a file name
                    and hold different parts (CG, 16 Oct). */}
                <span className="pn">{makes.length ? makes.join(', ') : s.fileName}</span>
                <span
                  className="chip"
                  data-testid={`plate-status-${s.id}`}
                  style={{ color: status.cls === 'ok' ? 'var(--ok)' : status.cls === 'crit' ? 'var(--red)' : 'var(--txt-3)' }}
                >
                  {status.text}
                </span>
                {fixes.length > 0 && (
                  <span className="chip" style={{ color: 'var(--warn)' }} title="A replacement file for a failed copy.">
                    reprint · {fixes.join('; ')}
                  </span>
                )}
                {/* The three things to see at a glance: when it printed, how
                    long it took, what it used -- the latest print, or the
                    file's own estimate before it has printed. */}
                <div className="platestats" data-testid={`plate-stats-${s.id}`}>
                  <span>
                    <i>Printed</i>
                    <b>{runs[0]?.startedAt ? runs[0].startedAt.slice(0, 10) : 'not yet'}</b>
                  </span>
                  <span>
                    <i>{runs[0] ? 'Took' : 'Will take'}</i>
                    <b>{runs[0] ? fmtHours(runs[0].hours ?? 0) : s.estMinutes != null ? `~${hrs(s.estMinutes)}` : '—'}</b>
                  </span>
                  <span>
                    <i>Filament</i>
                    <b>
                      {runs[0]
                        ? `${Math.round(runs[0].unitsUsed ?? 0)} ${runs[0].unit ?? 'g'}`
                        : s.estGrams != null
                          ? `~${Math.round(s.estGrams)} g`
                          : '—'}
                    </b>
                  </span>
                  {runs.length > 1 && (
                    <span>
                      <i>Prints</i>
                      <b>{runs.length}</b>
                    </span>
                  )}
                </div>
                {makes.length > 0 && <span className="plfile">{s.fileName}</span>}
                <span className="plmeta">
                  {s.slicedAt ? `sliced ${s.slicedAt.slice(0, 10)} · ` : ''}
                  {s.printerName ?? s.printerModel ?? 'machine not matched'}
                  {s.materialName ? ` · ${s.materialName}` : s.materialText ? ` · ${s.materialText}` : ''}
                  {runs[0] && s.estMinutes != null ? ` · file says ~${hrs(s.estMinutes)}` : ''}
                  {runs[0] && s.estGrams != null ? `, ~${Math.round(s.estGrams)} g` : ''}
                  {` · imported ${s.importedAt.slice(0, 10)}`}
                  {g.uploads > 1 ? ` · uploaded ${g.uploads} times — counted once` : ''}
                  {s.keptBytes != null ? ` · ${mb(s.keptBytes)} kept` : ''}
                </span>
                {s.keptBytes == null && (
                  <span
                    className="chip"
                    style={{ color: 'var(--warn)' }}
                    title="Only what this file said was kept, not the file. Imports from here on keep the file itself; re-import it to store a copy."
                  >
                    file not stored
                  </span>
                )}
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
                    className="btn sm"
                    disabled={busy || saving}
                    aria-expanded={sorting === s.id}
                    aria-label={`Sort parts of ${s.fileName}`}
                    title="Which part each object on this plate is. A print's copies move with its object."
                    onClick={() => {
                      setSortDraft({})
                      setSorting(sorting === s.id ? null : s.id)
                    }}
                  >
                    Sort parts
                  </button>
                  {canPrint(detail.phase, detail.facts.kind) && (
                    <button
                      type="button"
                      className={`btn sm ${runs.length ? '' : 'primary'}`}
                      disabled={busy || saving}
                      onClick={() => open(s)}
                    >
                      {runs.length ? 'Print it again' : 'This print happened'}
                    </button>
                  )}
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

            {s.estGrams == null && s.estMinutes == null && (
              <div className="attn warn" role="note" style={{ marginTop: 6 }}>
                <span>
                  No print time or filament came out of this file, so nothing can be filled in from
                  it.{' '}
                  {s.keptBytes != null
                    ? 'Guma reads more kinds of file now — try reading it again. '
                    : ''}
                  If that finds nothing, it was saved before slicing: in Bambu Studio or Orca,
                  slice, then File → Export → Export plate sliced file (.gcode.3mf), and import
                  that.
                </span>
                {s.keptBytes != null && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || saving}
                    onClick={() => void reread(s.id, s.fileName, runs.length)}
                  >
                    Read it again
                  </button>
                )}
              </div>
            )}
            {rereadMsg?.id === s.id && (
              <div className="attn crit" role="alert" style={{ marginTop: 6 }}>
                <span>{rereadMsg.text}</span>
              </div>
            )}


            {removing === s.id &&
              (() => {
                const runIdsHere = runs.map((r) => r.id)
                const withPrints = runs.length > 0 && removePrints
                const plan = plateRemoval(detail.parts, g.ids, runIdsHere, withPrints)
                const grams = runs.reduce((a, r) => a + (r.unitsUsed ?? 0), 0)
                return (
                  <div className="attn crit" style={{ marginTop: 8, display: 'block' }}>
                    <b>Remove {s.fileName}?</b>
                    <div style={{ marginTop: 4, fontSize: 12 }}>
                      The import, its estimates and the stored file go.
                    </div>
                    {runs.length > 0 && (
                      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 8, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={removePrints}
                          onChange={(e) => setRemovePrints(e.target.checked)}
                        />
                        <span>
                          Remove its {runs.length} print{runs.length === 1 ? '' : 's'} too — the copies{' '}
                          {runs.length === 1 ? 'it' : 'they'} marked go back to not printed
                          {grams > 0 ? `, and ${Math.round(grams)} g goes back on the shelf` : ''}.{' '}
                          <span style={{ color: 'var(--txt-3)' }}>
                            Untick if the print really happened: its cost stays, and so do its marks.
                          </span>
                        </span>
                      </label>
                    )}
                    {plan.remove.length > 0 && (
                      <div style={{ marginTop: 8, fontSize: 12 }}>
                        <b>Comes off the build sheet</b> — nothing else makes or marks{' '}
                        {plan.remove.length === 1 ? 'it' : 'them'}: {plan.remove.map((p) => p.label).join(', ')}
                      </div>
                    )}
                    {plan.keep.length > 0 && (
                      <div style={{ marginTop: 8, fontSize: 12 }} role="note" aria-label="Parts that stay">
                        <b>Stays on the build sheet, and why</b>
                        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                          {plan.keep.map((p) => (
                            <li key={p.id}>
                              <b>{p.label}</b> — {p.why}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="btnrow" style={{ marginTop: 10 }}>
                      <button
                        type="button"
                        className="btn sm danger"
                        disabled={saving}
                        onClick={() => void removeAll(g.ids, runIdsHere, withPrints, s.fileName)}
                      >
                        {saving ? 'Removing…' : 'Remove it'}
                      </button>
                      <button type="button" className="btn sm" onClick={() => setRemoving(null)}>
                        Keep it
                      </button>
                    </div>
                  </div>
                )
              })()}

            {sortMsg?.id === s.id && (
              <div className="hint" role="status" style={{ marginTop: 6, color: 'var(--ok)' }}>
                {sortMsg.text}
              </div>
            )}
            {sorting === s.id && (
              <div className="gatebox" style={{ marginTop: 8 }} role="group" aria-label={`Sort the parts of ${s.fileName}`}>
                <div className="hint" style={{ marginTop: 0, marginBottom: 6 }}>
                  Which part is each object on this plate?
                  {runs.length > 0 &&
                    ' Copies its prints marked move with it — off the part it leaves (back to how they were), onto the part it joins.'}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '30%' }}>Object in the file</th>
                      <th className="r">Copies</th>
                      <th className="r">Est. grams</th>
                      <th>Is the part</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.slices.find((x) => x.id === s.id)?.sections ?? []).map((sec) => (
                      <tr key={sec.id}>
                        <td>
                          <span className="pn">{sec.label}</span>
                        </td>
                        <td className="r">{sec.qty}</td>
                        <td className="r">{sec.estGrams == null ? '—' : Math.round(sec.estGrams)}</td>
                        <td>
                          <SortPick
                            id={`resort-${sec.id}`}
                            objectLabel={sec.label}
                            fileName={(detail.slices.find((x) => x.id === s.id)?.sections.length ?? 0) === 1 ? s.fileName : null}
                            guess={
                              sortDraft[sec.id] ??
                              (sec.partId
                                ? { choice: { kind: 'part', partId: sec.partId }, why: null }
                                : { choice: { kind: 'new', label: sec.label }, why: null })
                            }
                            parts={detail.parts}
                            onChange={(g2) => setSortDraft((d) => ({ ...d, [sec.id]: g2 }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="btnrow" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={saving || Object.keys(sortDraft).length === 0 || Object.values(sortDraft).some((x) => x.choice.kind === 'new' && !x.choice.label.trim())}
                    onClick={() => void saveSort(g)}
                  >
                    {saving ? 'Sorting…' : 'Save the sorting'}
                  </button>
                  <button type="button" className="btn sm" disabled={saving} onClick={() => setSorting(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {runs.length > 0 && (
              <div className="plateprints" role="list" aria-label={`Prints of ${s.fileName}`}>
                {runs.map((r) => (
                  <PrintLine
                    key={r.id}
                    run={r}
                    parts={detail.parts}
                    hideMarks={mine}
                    busy={busy || saving}
                    onCorrect={openId === s.id ? undefined : () => openCorrect(s, r)}
                    onRemove={async (undo) => {
                      setSaving(true)
                      setError(null)
                      try {
                        await deletePrintRun(ctx.shop.id, r.id, undo)
                        await onChanged()
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e))
                      } finally {
                        setSaving(false)
                      }
                    }}
                  />
                ))}
                {runs.length > 1 && (
                  <div className="plmeta">
                    {Math.round(used)} {ctx.materials.find((m) => m.id === s.materialId)?.unit ?? 'g'} ·{' '}
                    {fmtHours(hours)} across {runs.length} prints{failed ? `, ${failed} that did not finish` : ''}
                  </div>
                )}
              </div>
            )}
            {/* Recorded as clean, but a copy this plate prints has been
                failed since -- the record and the build sheet disagree.
                Say so where the fix is (CG, 14 Oct). */}
            {(() => {
              const latest = runs[0]
              if (!latest || latest.outcome !== 'success' || openId === s.id) return null
              const onPlate = new Set(g.ids.flatMap((id) => detail.slices.find((x) => x.id === id)?.sections ?? []).map((sec) => sec.partId))
              const failedHere = detail.parts.filter((p) => onPlate.has(p.id) && statesOf(p).includes('reprint'))
              if (!failedHere.length) return null
              return (
                <div className="attn warn" role="note" data-testid={`plate-disagrees-${s.id}`} style={{ marginTop: 6 }}>
                  <span>
                    Recorded as coming off clean, but {failedHere.map((p) => p.label).join(', ')}{' '}
                    {failedHere.length === 1 ? 'has' : 'have'} a copy marked failed since. If this print stopped
                    part way, correct it — Guma reads the file for how far it got and what it really used.
                  </span>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy || saving}
                    onClick={() => openCorrect(s, latest, 'cancelled')}
                  >
                    Correct this print
                  </button>
                </div>
              )
            })()}

            {openId === s.id && form && (
              <div className="gatebox" style={{ marginTop: 8 }}>
                {correcting && (
                  <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
                    <b>Correcting the print recorded{correcting.startedAt ? ` ${correcting.startedAt.slice(0, 10)}` : ''}</b>{' '}
                    — {Math.round(correcting.unitsUsed ?? 0)} {unit} · {fmtHours(correcting.hours ?? 0)} ·{' '}
                    {correcting.outcome === 'success' ? 'came off clean' : correcting.outcome === 'failed' ? 'failed' : 'stopped part way'}.
                    The machine and spool stay; the shelf moves by the difference.
                  </div>
                )}
                <div className="grid3">
                  <div className="fld">
                    <label className="lbl" htmlFor={`sr-printer-${s.id}`}>
                      Machine
                    </label>
                    <select
                      id={`sr-printer-${s.id}`}
                      disabled={!!correcting}
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
                      disabled={!!correcting}
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
                      disabled={!!correcting}
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
                      Machine time
                    </label>
                    <HoursInput
                      id={`sr-hours-${s.id}`}
                      label="Machine time"
                      value={form.hours}
                      onChange={(hours) => setForm((f) => f && { ...f, hours: hours ?? 0 })}
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
                {mine && form.outcome === 'success' && results.length > 1 && (
                  <ObjectResults
                    id={`sr-obj-${s.id}`}
                    results={results}
                    unit={unit}
                    onChange={(r) => {
                      setResults(r)
                      // What left the spool: what came off at the file's
                      // grams, what failed at what it weighed.
                      setForm((f) => f && { ...f, unitsUsed: Math.round(gramsUsed(r)) })
                    }}
                  />
                )}
                {(form.outcome !== 'success' || (mine && results.some((r) => r.failed))) && (
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
                {form.outcome !== 'success' && !mine && !correcting && plateParts(s.id).length > 1 && (
                  <CameOffOk
                    id={`sr-ok-${s.id}`}
                    labels={plateParts(s.id).map((x) => x.label)}
                    ok={okParts}
                    onChange={setOkParts}
                  />
                )}
                {form.outcome !== 'success' && (
                  <StoppedPrint
                    ctx={ctx}
                    slice={s}
                    unit={unit}
                    onApply={(hours, units, note) =>
                      setForm((f) => f && { ...f, hours, unitsUsed: units, note })
                    }
                  />
                )}
                {correcting && form.outcome !== 'success' && runMarks(detail.parts, correcting.id).length > 0 && (
                  <label
                    className="hint"
                    style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}
                  >
                    <input
                      type="checkbox"
                      checked={markParts}
                      onChange={(e) => setMarkParts(e.target.checked)}
                    />
                    Mark the copies this print marked printed as failed —{' '}
                    {runMarks(detail.parts, correcting.id)
                      .map((m) => `${m.label} ${m.copies.map((c) => `#${c}`).join(', ')}`)
                      .join('; ')}
                  </label>
                )}
                {!correcting && form.outcome !== 'success' && pendingPartsOf(s.id).length > 0 && (
                  <label
                    className="hint"
                    style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}
                  >
                    <input
                      type="checkbox"
                      checked={markParts}
                      onChange={(e) => setMarkParts(e.target.checked)}
                    />
                    Mark the copies this plate was printing as failed — the reason goes with them, and
                    each gets New file / Skip / Not printed on the build sheet
                  </label>
                )}
                {!correcting && form.outcome === 'success' && pendingPartsOf(s.id).length > 0 && (
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
                    {correcting ? 'Save the correction' : 'Record it'}
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={saving}
                    onClick={() => {
                      setOpenId(null)
                      setForm(null)
                      setCorrecting(null)
                    }}
                  >
                    Cancel
                  </button>
                  <span className="hint" style={{ marginTop: 0 }}>
                    {correcting
                      ? 'Saving changes the record in place: the spool gets back, or gives up, the difference.'
                      : 'These are the file’s numbers — change them to what the machine actually used if you know better. Recording takes the material off the shelf.'}
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}
      </div>
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
            title={`${v.fileName} · ${v.printerName ?? v.printerModel ?? 'unknown machine'} · imported ${v.importedAt.slice(0, 10)}${
              v.estGrams != null ? ` · ~${Math.round(v.estGrams)} g` : ''
            }`}
            onClick={() => void choose(v.sectionId)}
          >
            {/* Which FILE, not only which machine: two files for one part on
                one machine read as the same chip twice (CG, 15 Oct). */}
            <span className="pvar-file">{v.fileName.replace(/\.(gcode\.3mf|bgcode|gcode|3mf)$/i, '')}</span> ·{' '}
            {mins(v.estMinutes)}
            {v.estGrams != null ? ` · ${Math.round(v.estGrams)} g` : ''}
          </button>
        )
      })}
      {part.variants.length > 1 && !picked && (
        <span className="pmeta" style={{ color: 'var(--warn)' }}>
          {spread ? `estimating from the fastest — ${spread}% between them; click one to choose` : 'estimating from the first; click one to choose'}
        </span>
      )}
      {isOnSharedPlate(variant) && (
        <span
          className="pmeta"
          title={`Shares a plate with ${(variant?.plateParts ?? 1) - 1} other objects — one print, not several.`}
        >
          on a plate of {variant?.plateParts ?? 1}
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
          {fmtHours(plan.printHours)} of machine time here. Set a delivery date and Guma
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
        {fmtHours(plan.printHours)} of machine time still to print
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
        <h4>{f.kind === 'inhouse' ? 'What it came to' : 'What this project came to'}</h4>
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
            value={hours ? fmtHours(hours) : '—'}
            sub={`${fmtHours(a.machineHours)} machine · ${fmtHours(
              a.designHours + a.finishingHours + a.adminHours,
            )} yours`}
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
            value={
              !detail.parts.length
                ? 'no build sheet'
                : // Passing is optional for your own work: what matters is
                  // what was made, not a check nobody asked for (CG, 13 Oct).
                  f.kind === 'inhouse' && f.partsPassed === 0
                  ? `${f.copiesDone} of ${f.copies} cop${f.copies === 1 ? 'y' : 'ies'} made`
                  : `${f.partsPassed} of ${f.parts} passed`
            }
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
                          `${Math.round(used)} g · ${fmtHours(hrs)}`
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
          {f.kind === 'inhouse'
            ? 'Every run, hour and part is still here.'
            : (f.deliveryOn
                ? `Handed over ${formatDate(f.deliveryOn, locale)}${f.deliveryHow ? ` · ${f.deliveryHow}` : ''}.`
                : 'No handover date was recorded.') + ' Everything below is still here — it is just no longer the point.'}
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
  const [saving, setSaving] = useState(false)

  if (!rows) return null
  const id = detail.jobId
  const kids = childrenOf(rows, id)
  const inside = descendantsOf(rows, id)
  const path = ancestorsOf(rows, id)
  const parent = path[path.length - 1] ?? null
  const total = programTotals(rows, id)
  const g = (n: number) => `${Math.round(n)} g`
  const h = (n: number) => fmtHours(n)
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

  return (
    <details
      className="sec fold"
      data-fold="program"
      style={{ marginTop: 18 }}
      open={open}
      onToggle={(e) => onToggle(e.currentTarget.open)}
    >
      <summary className="sechead">
        <h4>Linked projects</h4>
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

      <div className="hint" style={{ marginTop: 10 }}>
        An older link between projects. Projects are grouped in a series now (above); take this
        out once it is filed there.
      </div>
      {parent && (
        <div className="btnrow" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy || saving}
            onClick={() => void guard(() => setRelatedProject(ctx.shop.id, id, null))}
          >
            Take it out of {parent.title}
          </button>
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
  whatIf,
  onQuoteStatus,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  locked: boolean
  busy: boolean
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
  /** What the price and the spool hold become with these parts instead --
   *  worked out where the quote, stock and holds are (the Project page). */
  whatIf?: (parts: PartRow[]) => WhatIf
  /** Set the newest quote's status -- for a revision made while building. */
  onQuoteStatus?: (status: QuoteStatus) => void
}) {
  const [label, setLabel] = useState('')
  const [qty, setQty] = useState('1')
  const [addWhy, setAddWhy] = useState('')
  const [saving, setSaving] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  /** "A part with no file" -- the exception, so folded until asked for. */
  const [byHand, setByHand] = useState(false)
  /**
   * The plates that make each part (CG, 21 Oct: the parts list was a second
   * list that drifted from the plates). A part a plate makes is counted from
   * that plate's prints; only a part with no plate is marked by hand.
   */
  const groupsAll = groupSliceFiles(detail.slices, detail.runs)
  const stranded = strandedReport(detail.parts, detail.runs)
  /** Your own work is plates and what they made -- no parts list beside
   *  them (CG, 21 Oct: "We can just use plates and what it took"). */
  const plateOnly = detail.facts.kind === 'inhouse'
  const platesOf = (partId: string) =>
    groupsAll.filter((g) => detail.slices.find((x) => x.id === g.first.id)?.sections.some((sec) => sec.partId === partId))
  /** Objects on a plate that no part on this list counts -- their part was
   *  removed, or never made. Counting them is one click. */
  const uncounted = groupsAll.flatMap((g) =>
    (detail.slices.find((x) => x.id === g.first.id)?.sections ?? [])
      .filter((sec) => !sec.partId || !detail.parts.some((p) => p.id === sec.partId))
      .map((sec) => ({ sec, g })),
  )
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
  /** The part and the move being made on it -- one at a time. */
  const [act, setAct] = useState<{ partId: string; to: PartStatus } | null>(null)
  /** How many copies the open move moves. */
  const [n, setN] = useState(1)
  /** The part with its per-copy list open. */
  const [copiesOpen, setCopiesOpen] = useState<string | null>(null)
  // A part's history drawer changes the height of the build sheet above
  // whatever you click next. See rowAnchor.ts.
  const holdRow = useRowAnchor(openId)
  const [why, setWhy] = useState('')
  const [fix, setFix] = useState('')
  const [fixedFile, setFixedFile] = useState<File | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [removeWhy, setRemoveWhy] = useState('')
  /**
   * Parts ticked for one copy count (CG, 12 Oct: "reduce the number of
   * parts needed down to 4 for some of the parts"). Tick, type the count,
   * see what it does to each part, the price and the spool, then save once.
   */
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [setTo, setSetTo] = useState('')
  const [bulkWhy, setBulkWhy] = useState('')
  const [bulkSaid, setBulkSaid] = useState<string | null>(null)
  /** The sliced file a part was imported from, if any. */
  const fileOf = (partId: string) =>
    detail.slices.find((sl) => sl.sections.some((sec) => sec.partId === partId))?.fileName ?? null

  /**
   * Send a part back, Voltage's way: why it failed, how to make the next
   * attempt work, and -- when the fix was a re-slice -- the fixed file
   * itself. The file goes through the same import as any other, so it
   * updates this part's estimate rather than adding a duplicate row, is
   * kept with the project, and waits under "Sliced files" to be recorded
   * when the reprint comes off the bed.
   */
  /** Read a re-sliced file onto this part: same import as any other, so it
   *  becomes the part's slice rather than a duplicate row. */
  async function importFixed(
    part: PartRow,
    file: File,
  ): Promise<{ name: string; importId: string; duplicateOf?: string }> {
    const parsed = await parseSliceFile(file)
    // A re-sliced plate can carry other objects too, but one of them has to
    // be this part -- otherwise the file is not its fix, and importing it
    // would quietly add new parts to the build sheet.
    if (
      parsed.sections.length > 1 &&
      !parsed.sections.some((sec) => sec.label.trim().toLowerCase() === part.label.trim().toLowerCase())
    ) {
      throw new Error(
        `${parsed.fileName} has ${parsed.sections.length} objects on it and none is named “${part.label}”, so it is not this part's fix. Slice the part on its own, or keep its name, and try again.`,
      )
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const r = await importSlice(ctx.shop.id, detail.jobId, ctx.profile.id, {
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
      progress: parsed.progress,
      forPartId: part.id,
      sections: parsed.sections.map((sec) => ({
        label: sec.label,
        qty: sec.qty,
        estMinutes: sec.estMinutes,
        estGrams: sec.estGrams,
        material: sec.material,
      })),
    })
    return { name: parsed.fileName, importId: r.importId, duplicateOf: r.duplicateOf ?? undefined }
  }

  /**
   * A failed copy, with a fixed file: the file goes on the part and the
   * copy goes back in the queue to print from it (CG, 8 Oct: "an immediate
   * way to substitute a new file").
   */
  async function replaceCopyFile(part: PartRow, copy: number, file: File) {
    const r = await importFixed(part, file)
    // The same file again is not a fix. Allowed only when it is already a
    // replacement for this part -- one fixed file for two failed copies.
    if (r.duplicateOf && !part.history.some((h) => h.sliceImportId === r.importId)) {
      throw new Error(
        `${r.name} is already on this project (imported ${r.duplicateOf.slice(0, 10)}) — the same file the copy failed from. To print it again unchanged, set the copy to Not printed; to use a fix, export the re-sliced file and upload that.`,
      )
    }
    await requeueCopyFromFile(ctx.shop.id, part.id, ctx.profile.id, copy, r.importId, r.name)
  }

  async function sendBack(part: PartRow) {
    const fileName = fixedFile ? (await importFixed(part, fixedFile)).name : null
    await movePartCopies(ctx.shop.id, part.id, ctx.profile.id, 'reprint', n, reprintNote(why, fix, fileName))
    setAct(null)
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

  /**
   * Start a move on a part. One copy left to move needs no question, so it
   * just happens; more than one asks how many, starting from the likeliest
   * answer -- the copies one plate holds when printing, all of them when
   * passing, one when failing. Failing always asks why.
   */
  function open(part: PartRow, to: PartStatus) {
    const c = copiesOf(part)
    const max = movable(c, to)
    if (to !== 'reprint' && max === 1) {
      void guard(() => movePartCopies(ctx.shop.id, part.id, ctx.profile.id, to, 1, null))
      return
    }
    const perPlate = chosenVariant(part).variant?.sectionQty ?? 1
    setN(to === 'printed' ? Math.min(max, perPlate) : to === 'passed' ? max : 1)
    setAct({ partId: part.id, to })
    if (to === 'reprint') {
      setWhy('')
      setFix('')
      setFixedFile(null)
    }
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
      {/* Read files in while the job is priced, designed, planned or built
          (fixed files); not once it is being checked or is done. */}
      {canImport(detail.phase, detail.facts.kind) && (
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
      {!plateOnly && shouldReturnToBuilding(detail.phase, detail.parts) && (
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

      {/* No separate failures line (CG, 20 Oct: "still is confusing ... just
          eliminate that section"). Each failure is on its plate's print, and
          What it took totals what failures cost. */}
      {plateOnly ? null : detail.parts.length === 0 && uncounted.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--txt-2)', marginTop: 14 }}>
          Nothing here yet — drop the sliced files above. Each one becomes a plate, and what is on it
          is listed here as what this project makes. Something with no file can be added by hand
          below.
        </div>
      ) : detail.parts.length === 0 ? null : (
        <>
        {picked.size > 0 && (
          <CopiesBar
            parts={detail.parts}
            picked={picked}
            setTo={setTo}
            onSetTo={setSetTo}
            why={bulkWhy}
            onWhy={setBulkWhy}
            whyNeeded={locked}
            whatIf={whatIf}
            money={makeMoney(ctx.shop.currency, ctx.shop.locale).money}
            busy={busy || saving}
            onClear={() => {
              setPicked(new Set())
              setSetTo('')
              setBulkWhy('')
            }}
            onSave={(changes, release) =>
              guard(async () => {
                const out = await setPartsCopies(ctx.shop.id, detail.jobId, ctx.profile.id, changes, bulkWhy)
                // The spool hold follows the sheet down, never up (lib/scheduleCheck.ts trimHolds).
                if (release) await setStockHolds(ctx.shop.id, detail.jobId, ctx.profile.id, release.holds)
                const spares = out.reduce((a, x) => a + x.toSpare, 0)
                setBulkSaid(
                  `${out.length} part${out.length === 1 ? '' : 's'} set to ${changes[0]?.qty} cop${changes[0]?.qty === 1 ? 'y' : 'ies'}` +
                    (spares ? ` · ${spares} printed cop${spares === 1 ? 'y' : 'ies'} kept as spare${spares === 1 ? '' : 's'}` : '') +
                    (release ? ` · ${release.released.map((r) => `${r.units.toLocaleString()}${r.unit} ${r.name}`).join(', ')} back on the shelf` : '') +
                    '.',
                )
                setPicked(new Set())
                setSetTo('')
                setBulkWhy('')
              })
            }
          />
        )}
        {bulkSaid && picked.size === 0 && (
          <div className="hint" role="status" style={{ color: 'var(--ok)', marginTop: 8 }}>
            {bulkSaid}
          </div>
        )}
        <div className="sechead" style={{ marginTop: 14 }}>
          <h4>What this makes</h4>
          <span className="sub">
            Worked out from the plates below: a plate&rsquo;s prints mark its parts. Change how many you
            need with edit.
          </span>
        </div>
        {/* Parts with no plate behind them (CG, 23-24 Oct): an earlier plate
            removal left them, and the prints it left still mark copies.
            Each says what marked it; nothing is undone by itself -- a part
            or print typed in by hand on purpose looks the same. */}
        {!locked && (stranded.clear.length > 0 || stranded.marked.length > 0) && (detail.slices.length > 0 || stranded.prints.length > 0) && (
          <div className="attn warn" role="note" aria-label="Parts with no plate" style={{ marginTop: 8, display: 'block' }}>
            <b>
              {stranded.clear.length + stranded.marked.length} part
              {stranded.clear.length + stranded.marked.length === 1 ? ' has' : 's have'} no plate behind{' '}
              {stranded.clear.length + stranded.marked.length === 1 ? 'it' : 'them'}
            </b>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              Usually left by a plate that was removed. The plates below are the record; these are not on any of them.
            </div>
            {stranded.marked.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
                {stranded.marked.map((p) => (
                  <li key={p.id}>
                    <b>{p.label}</b>: {p.why}
                  </li>
                ))}
              </ul>
            )}
            {stranded.prints.map((r) => (
              <div key={r.id} className="btnrow" style={{ marginTop: 8, alignItems: 'center', fontSize: 12 }}>
                <span style={{ flex: 1, minWidth: 220 }}>
                  The print of <b>{r.said}</b> has no plate and marks {r.parts.join(', ')}. If it came off a plate you
                  removed and that is not what was printed, undo it: those copies go back to not printed and its
                  filament goes back on the shelf. If it really happened, keep it.
                </span>
                <button
                  type="button"
                  className="btn sm danger"
                  disabled={busy || saving}
                  onClick={() =>
                    void (async () => {
                      setSaving(true)
                      try {
                        await deletePrintRun(ctx.shop.id, r.id, true)
                        await onChanged()
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e))
                      } finally {
                        setSaving(false)
                      }
                    })()
                  }
                >
                  Undo the print of {r.said.split(',')[0]}
                </button>
              </div>
            ))}
            {stranded.clear.length > 0 && (
              <div className="btnrow" style={{ marginTop: 8, alignItems: 'center', fontSize: 12 }}>
                <span style={{ flex: 1, minWidth: 220 }}>
                  Nothing printed: {stranded.clear.map((p) => p.label).join(', ')}. Keep{' '}
                  {stranded.clear.length === 1 ? 'it' : 'them'} only if you will still print{' '}
                  {stranded.clear.length === 1 ? 'it' : 'them'} by hand — otherwise{' '}
                  {stranded.clear.length === 1 ? 'it inflates' : 'they inflate'} the copy count.
                </span>
                <button
                  type="button"
                  className="btn sm danger"
                  disabled={busy || saving}
                  onClick={() =>
                    void (async () => {
                      setSaving(true)
                      try {
                        for (const p of stranded.clear)
                          await deletePart(ctx.shop.id, p.id, ctx.profile.id, 'No plate behind it and nothing printed — cleared from the build sheet.')
                        await onChanged()
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e))
                      } finally {
                        setSaving(false)
                      }
                    })()
                  }
                >
                  Remove {stranded.clear.length === 1 ? 'it' : `these ${stranded.clear.length}`}
                </button>
              </div>
            )}
          </div>
        )}
        <div className="sheetwrap" style={{ maxHeight: 'none' }} role="region" aria-label="What this makes">
          <table>
            <thead>
              <tr>
                <th className="pick">
                  <input
                    type="checkbox"
                    aria-label="Pick every part"
                    checked={picked.size > 0 && picked.size === detail.parts.length}
                    ref={(el) => {
                      if (el) el.indeterminate = picked.size > 0 && picked.size < detail.parts.length
                    }}
                    disabled={busy || saving}
                    onChange={(e) => setPicked(e.target.checked ? new Set(detail.parts.map((x) => x.id)) : new Set())}
                  />
                </th>
                <th className="chev" aria-label="Show copies" />
                <th>Part</th>
                <th style={{ width: 190 }}>Copies</th>
                <th style={{ width: 210 }} />
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {detail.parts.map((p, i) => (
                <Fragment key={p.id}>
                  <tr
                    className={`partrow ${copiesOpen === p.id ? 'open' : ''} ${
                      landed > 0 && i >= detail.parts.length - landed ? 'landed' : ''
                    }`.trim()}
                  >
                    <td className="pick">
                      <input
                        type="checkbox"
                        aria-label={`Pick ${p.label}`}
                        checked={picked.has(p.id)}
                        disabled={busy || saving}
                        onChange={(e) =>
                          setPicked((cur) => {
                            const next = new Set(cur)
                            if (e.target.checked) next.add(p.id)
                            else next.delete(p.id)
                            return next
                          })
                        }
                      />
                    </td>
                    <td className="chev">
                      {/* The whole point of the row is its copies, so opening
                          them is a big target at the start of the row, not a
                          link buried mid-row (CG, 8 Oct). */}
                      <button
                        type="button"
                        className="chevbtn"
                        aria-expanded={copiesOpen === p.id}
                        aria-label={`Each copy of ${p.label}`}
                        onClick={() => setCopiesOpen(copiesOpen === p.id ? null : p.id)}
                      >
                        {copiesOpen === p.id ? '▾' : '▸'}
                      </button>
                    </td>
                    <td>
                      <div className="pn">{p.label}</div>
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
                      {(() => {
                        const made = platesOf(p.id)
                        // Before anything prints, which file the estimate comes
                        // from is a choice worth showing; after, where the part
                        // comes from is all that matters.
                        if (!canPrint(detail.phase, detail.facts.kind) && p.variants.length > 1)
                          return (
                            <PartVariants ctx={ctx} part={p} busy={busy || saving} onChanged={onChanged} setError={setError} />
                          )
                        return made.length ? (
                          <div className="pmeta" data-testid={`made-by-${p.id}`}>
                            from {made.map((g) => g.first.fileName).join(' · ')}
                          </div>
                        ) : (
                          <div className="pmeta">no file — marked by hand</div>
                        )
                      })()}
                    </td>
                    <td>
                      {(() => {
                        const c = copiesOf(p)
                        const fileOfId = (id: string) => detail.slices.find((sl) => sl.id === id)?.fileName ?? null
                        const states = statesOf(p)
                        const queued = new Set(
                          states.map((st, i) => (st === 'pending' && copyStory(p, i, fileOfId).file ? i : -1)).filter((i) => i >= 0),
                        )
                        return (
                          <div
                            className="copycell"
                            title={copiesOpen === p.id ? 'Hide the copies' : 'Show each copy'}
                            onClick={() => setCopiesOpen(copiesOpen === p.id ? null : p.id)}
                          >
                            <CopyBar states={states} queued={queued} />
                            <div
                              className="pmeta"
                              data-testid={`copies-${p.id}`}
                              style={{
                                color:
                                  c.reprint > 0
                                    ? 'var(--red)'
                                    : p.status === 'passed'
                                      ? 'var(--ok)'
                                      : c.printed + c.passed > 0
                                        ? 'var(--warn)'
                                        : undefined,
                              }}
                            >
                              {describeCopies(c)}
                              {p.spareN > 0 && ` · ${p.spareN} spare${p.spareN === 1 ? '' : 's'}`}
                              {queued.size > 0 && ` · ${queued.size} reprint${queued.size === 1 ? '' : 's'} queued`}
                            </div>
                          </div>
                        )
                      })()}
                    </td>
                    <td>
                      {act?.partId === p.id && act.to !== 'reprint' ? (
                        <CountPicker
                          label={act.to === 'printed' ? 'How many came off?' : 'How many passed?'}
                          id={`n-${p.id}`}
                          value={n}
                          max={movable(copiesOf(p), act.to)}
                          onChange={setN}
                          busy={busy || saving}
                          onSave={() =>
                            void guard(async () => {
                              await movePartCopies(ctx.shop.id, p.id, ctx.profile.id, act.to, n, null)
                              setAct(null)
                            })
                          }
                          onCancel={() => setAct(null)}
                        />
                      ) : (
                        <div className="partacts">
                          {allowedStatuses(detail.phase, detail.facts.kind)
                            // A part a plate makes is marked printed by that plate's
                            // prints -- one place to record, not two. Failing a copy
                            // found bad after it came off, and checking, stay here.
                            .filter((st) => !(st === 'printed' && platesOf(p.id).length > 0))
                            .filter((st) => movable(copiesOf(p), st) > 0)
                            .map((st) => {
                              const c = copiesOf(p)
                              const name =
                                st === 'printed' ? (c.reprint > 0 && c.pending === 0 ? 'Reprinted' : 'Printed') : st === 'passed' ? 'Pass' : 'Fail'
                              return (
                                <button
                                  key={st}
                                  type="button"
                                  className={`btn sm ${st === 'reprint' ? 'danger' : st === 'passed' ? 'primary' : ''}`.trim()}
                                  disabled={busy || saving}
                                  aria-label={`${name} ${p.label}`}
                                  onClick={() => open(p, st)}
                                >
                                  {name}
                                </button>
                              )
                            })}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="partlinks">
                        {p.history.length > 1 && (
                          <button
                            type="button"
                            className="linkbtn"
                            onClick={(e) => {
                              holdRow(e.currentTarget.closest('tr'))
                              setOpenId(openId === p.id ? null : p.id)
                            }}
                          >
                            history ({p.history.length})
                          </button>
                        )}
                        <button
                          type="button"
                          className="linkbtn"
                          disabled={busy || saving}
                          aria-label={`Edit ${p.label}`}
                          onClick={() => setEditId(editId === p.id ? null : p.id)}
                        >
                          edit
                        </button>
                        {/* Remove is offered at every stage: a part that is
                            wrong is wrong whenever it is noticed. It asks
                            first, and from Review on it asks why. */}
                        <button
                          type="button"
                          className="linkbtn"
                          disabled={busy || saving}
                          aria-label={`Remove ${p.label}`}
                          onClick={() => {
                            setRemoveId(removeId === p.id ? null : p.id)
                            setRemoveWhy('')
                          }}
                        >
                          remove
                        </button>
                      </div>
                    </td>
                  </tr>
                  {copiesOpen === p.id && (
                    <tr className="copiesrow">
                      <td colSpan={6}>
                        <EachCopy
                          part={p}
                          options={copyOptions(detail.phase, detail.facts.kind)}
                          busy={busy || saving}
                          onSet={(copies, to, why) =>
                            guard(() => setCopyStates(ctx.shop.id, p.id, ctx.profile.id, copies, to, why))
                          }
                          onNewFile={(copy, file) => guard(() => replaceCopyFile(p, copy, file))}
                          fileName={(id) => detail.slices.find((sl) => sl.id === id)?.fileName ?? null}
                          onSkip={(copy, why) => guard(() => skipCopy(ctx.shop.id, p.id, ctx.profile.id, copy, why))}
                          onClose={() => setCopiesOpen(null)}
                        />
                      </td>
                    </tr>
                  )}
                  {removeId === p.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--panel-3)' }}>
                        <div className="attn crit" style={{ margin: 0 }}>
                          {platesOf(p.id).length > 0 ? (
                            <>
                              <b>{p.label} is made by {platesOf(p.id).map((g) => g.first.fileName).join(' and ')}.</b>
                              <div style={{ marginTop: 4, fontSize: 12 }}>
                                Removing it here would leave the plate printing something this list no longer counts —
                                the mismatch this list used to have. Use <b>Sort parts</b> on the plate to put its object
                                on another part, or remove the plate itself.
                              </div>
                              <div className="btnrow" style={{ marginTop: 8 }}>
                                <button type="button" className="btn sm" onClick={() => setRemoveId(null)}>
                                  OK
                                </button>
                              </div>
                            </>
                          ) : (
                          <>
                          <b>
                            Remove “{p.label}” ×{p.qty} from the build sheet?
                          </b>
                          <div style={{ marginTop: 4, fontSize: 12 }}>
                            Its status history goes with it; the removal is recorded in Activity.
                            Prints already recorded stay — their filament and hours were really used.
                            {fileOf(p.id) &&
                              ` It came from ${fileOf(p.id)}: importing that file again would add it back.`}
                          </div>
                          {locked && (
                            <div className="fld" style={{ margin: '8px 0 0' }}>
                              <label className="lbl" htmlFor={`rm-why-${p.id}`}>
                                Why? (required once the sheet has been checked)
                              </label>
                              <input
                                id={`rm-why-${p.id}`}
                                value={removeWhy}
                                autoFocus
                                placeholder="Added by mistake, duplicate, wrong file…"
                                onChange={(e) => setRemoveWhy(e.target.value)}
                              />
                            </div>
                          )}
                          <div className="btnrow" style={{ marginTop: 8 }}>
                            <button
                              type="button"
                              className="btn sm danger"
                              disabled={busy || saving || (locked && !removeWhy.trim())}
                              onClick={() =>
                                void guard(async () => {
                                  await deletePart(ctx.shop.id, p.id, ctx.profile.id, removeWhy || null)
                                  setRemoveId(null)
                                  setRemoveWhy('')
                                })
                              }
                            >
                              Remove it
                            </button>
                            <button type="button" className="btn sm" onClick={() => setRemoveId(null)}>
                              Keep it
                            </button>
                          </div>
                          </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  {editId === p.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--panel-3)' }}>
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
                  {act?.partId === p.id && act.to === 'reprint' && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--panel-3)' }}>
                        {movable(copiesOf(p), 'reprint') > 1 && (
                          <div className="fld" style={{ margin: '0 0 6px', maxWidth: 220 }}>
                            <label className="lbl" htmlFor={`fail-n-${p.id}`}>
                              How many failed? (of {movable(copiesOf(p), 'reprint')})
                            </label>
                            <input
                              id={`fail-n-${p.id}`}
                              type="number"
                              min={1}
                              max={movable(copiesOf(p), 'reprint')}
                              value={n}
                              onChange={(e) => setN(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                            />
                          </div>
                        )}
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
                            {n > 1 ? `Mark ${n} failed` : 'Mark it failed'}
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost"
                            onClick={() => setAct(null)}
                          >
                            Cancel
                          </button>
                          <span className="hint" style={{ marginTop: 0 }}>
                            Failed copies go back to be printed again, with this reason on the row.
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {openId === p.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--panel-2)' }}>
                        {p.history.map((h) => (
                          <div key={h.id} className="histitem">
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--txt-3)' }}>
                              {h.at.slice(0, 10)}
                            </span>
                            <span style={{ color: 'var(--txt-2)' }}>
                              {h.copies && h.kind === 'status'
                                ? `Cop${h.copies.length === 1 ? 'y' : 'ies'} ${h.copies.join(', ')} → ${COPY_MOVE_LABEL[h.toStatus ?? 'pending']}`
                                : h.n != null && h.kind === 'status'
                                ? `${h.n} cop${h.n === 1 ? 'y' : 'ies'} → ${COPY_MOVE_LABEL[h.toStatus ?? 'pending']}`
                                : h.fromStatus
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
        </>
      )}

      {detail.parts.length > 0 && !plateOnly && (
        <div className="sheetsum">
          <span>One box per copy: amber = printed · green = passed · red = going back · dashed = reprint queued</span>
          <span style={{ marginLeft: 'auto' }}>
            {detail.facts.parts} part{detail.facts.parts === 1 ? '' : 's'} ·{' '}
            {(() => {
              const n = detail.parts.reduce((a, p) => a + p.qty, 0)
              return `${n} cop${n === 1 ? 'y' : 'ies'}`
            })()}
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

      {/* Objects on a plate this list does not count: their part was removed
          before plates and parts were one list (CG's Maui: LAND FLUSH and
          MauiNui printed, but the sheet said 2 of 2). One click counts them,
          from their prints. */}
      {uncounted.length > 0 && !plateOnly && (
        <div className="attn warn" role="note" aria-label="Not counted" style={{ marginTop: 10 }}>
          <div style={{ flex: 1 }}>
            <b>
              {uncounted.length === 1 ? 'A plate makes something' : `Plates make ${uncounted.length} things`} this list
              does not count.
            </b>
            {uncounted.map(({ sec, g }) => (
              <div key={sec.id} style={{ fontSize: 12, marginTop: 4 }}>
                {sec.label} — on {g.first.fileName}
                {g.runs.length ? `, printed ${g.runs.length} time${g.runs.length === 1 ? '' : 's'}` : ''}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || saving}
            onClick={() =>
              void guard(async () => {
                for (const { sec } of uncounted)
                  await moveSliceSection(ctx.shop.id, detail.jobId, ctx.profile.id, sec.id, { label: sec.label })
              })
            }
          >
            Count {uncounted.length === 1 ? 'it' : 'them'}
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

      {/* Once building, Estimated build is gone from the page -- so a build
          sheet that no longer matches the agreed quote says so here, with
          the same one-click revision (CG, 12 Oct: fewer copies in In build
          should reach the price, without changing it behind the client). */}
      {(() => {
        const at = phaseIndex(detail.phase)
        if (!whatIf || at < phaseIndex('building') || at > phaseIndex('review')) return null
        const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)
        const q = detail.quote
        const hasPending =
          !!q && (q.status === 'draft' || q.status === 'sent') && detail.facts.quoteStatus === 'accepted'
        const pending =
          onQuoteStatus && detail.phase === 'building' && hasPending ? (
            <PendingRevision detail={detail} money={money} busy={busy || saving} onMark={onQuoteStatus} />
          ) : null
        const pr = whatIf(detail.parts).price
        if (!pr || !pr.changed) return pending
        const d = pr.sheet - pr.quoted
        return (
          <>
          <div className="attn warn" data-testid="sheet-price-build" style={{ marginTop: 10 }}>
            <span>
              <strong>The build sheet now prices at {money(pr.sheet)}</strong> — {pr.sheetCopies} copies against{' '}
              {pr.quotedCopies} quoted at {money(pr.quoted)}
              {Math.abs(d) >= 0.005 ? ` (${d < 0 ? '−' : '+'}${money(Math.abs(d))})` : ''}.{' '}
              {detail.facts.quoteStatus === 'accepted'
                ? 'The client agreed to the quoted price; it stands until they accept a revision.'
                : 'The quote stays as sent until you revise it.'}
            </span>
            {!pending && (
              <Link to={`/intake?revise=${detail.jobId}&from=sheet`} className="btn sm" style={{ textDecoration: 'none' }}>
                Revise the quote to match
              </Link>
            )}
          </div>
          {pending}
          </>
        )
      })()}

      {/* Parts can be added at any stage. Before Review it is just a list
          being built. From Review on the list has been checked, so adding to
          it needs a reason, which goes in Activity -- CG: "allow projects
          to be editable in terms of adding more pieces". */}
      {plateOnly ? null : !byHand && !(detail.parts.length === 0 && detail.slices.length === 0) ? (
        <button
          type="button"
          className="linkbtn"
          style={{ marginTop: 10, width: 'auto', fontSize: 12 }}
          onClick={() => setByHand(true)}
        >
          + A part with no file
        </button>
      ) : (
      <>
      <div className="btnrow" style={{ marginTop: 10, alignItems: 'flex-end' }}>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 180 }}>
          <label className="lbl" htmlFor="part-label">
            {locked ? 'Add another part' : 'Part'}
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
        {locked && (
          <div className="fld" style={{ margin: 0, flex: 1, minWidth: 200 }}>
            <label className="lbl" htmlFor="part-why">
              Why, now it has been checked
            </label>
            <input
              id="part-why"
              value={addWhy}
              placeholder={
                detail.facts.kind === 'inhouse' ? 'A base for the set, a missing piece…' : 'Second tile for the client, a missing piece…'
              }
              onChange={(e) => setAddWhy(e.target.value)}
            />
          </div>
        )}
        <button
          type="button"
          className="btn sm primary"
          disabled={busy || saving || !label.trim() || (locked && !addWhy.trim())}
          onClick={() =>
            void guard(async () => {
              await addPart(ctx.shop.id, detail.jobId, ctx.profile.id, {
                label,
                qty: Number(qty) || 1,
                reason: locked ? addWhy : null,
              })
              setLabel('')
              setQty('1')
              setAddWhy('')
            })
          }
        >
          Add
        </button>
      </div>
      {locked && (
        <div className="hint" style={{ marginTop: 6 }}>
          This sheet was checked at {phaseLabel('review', detail.facts.kind)}. A part added now starts as
          not printed and is logged with your reason. If it still has to be printed, move the project
          back a stage at the top.
        </div>
      )}
      </>
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
/**
 * What it took, as totals: the prints themselves are listed once, under
 * their plates. This is the sum a person checks -- filament, machine time,
 * their own time, and what failures cost of it.
 */
function TookTotals({
  ctx,
  detail,
  money,
  fromPlates,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  money: (n: number) => string
  fromPlates: number
}) {
  const a = detail.actuals
  const yours = a.designHours + a.finishingHours + a.adminHours
  const lost = detail.runs.filter((r) => r.outcome !== 'success')
  const lostH = lost.reduce((t, r) => t + (r.hours ?? 0), 0)
  // From the prints themselves: a stopped print burned filament too, which
  // the actuals' failedUnits (failed outcomes only) leaves out.
  const lostRunsU = lost.reduce((t, r) => t + (r.unitsUsed ?? 0), 0)
  // And on your own work, the objects that failed on a plate that otherwise
  // came off (CG, 21 Oct) -- each one's grams and its share of the print.
  const [pieces, setPieces] = useState<MadeItemRow[]>([])
  const runKey = detail.runs.map((r) => `${r.id}:${r.unitsUsed}:${r.outcome}`).join('|')
  useEffect(() => {
    if (detail.facts.kind !== 'inhouse') return
    let live = true
    listMadeItems(ctx.shop.id, detail.jobId)
      .then((x) => live && setPieces(x))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [ctx.shop.id, detail.jobId, detail.facts.kind, runKey])
  const okRuns = new Set(detail.runs.filter((r) => r.outcome === 'success').map((r) => r.id))
  const partFails = pieces.filter((p) => p.status === 'failed' && p.runId && okRuns.has(p.runId))
  const lostU = lostRunsU + partFails.reduce((t, p) => t + (p.grams ?? 0), 0)
  const lostN = lost.length + partFails.length
  const unit = detail.runs[0]?.unit ?? 'g'
  return (
    <div className="tooktot" data-testid="took-totals">
      <div>
        <span className="lbl">Filament</span>
        <b>
          {Math.round(a.materialUnits)} {unit}
        </b>
        <span className="sub">{money(a.materialCost)} off the shelf</span>
      </div>
      <div>
        <span className="lbl">Machine time</span>
        <b>{fmtHours(a.machineHours)}</b>
        <span className="sub">
          {a.runs} print{a.runs === 1 ? '' : 's'}
          {fromPlates > 0 ? ` · ${fromPlates === a.runs ? 'all' : fromPlates} listed under their plates` : ''}
        </span>
      </div>
      <div>
        <span className="lbl">Your time</span>
        <b>{fmtHours(yours)}</b>
        <span className="sub">{yours > 0 ? 'logged below' : 'nothing logged yet'}</span>
      </div>
      <div>
        <span className="lbl">Lost to failures</span>
        <b style={{ color: lostN ? 'var(--red)' : undefined }}>
          {lostN ? `${Math.round(lostU)} ${unit}${lostH > 0 ? ` · ${fmtHours(lostH)}` : ''}` : 'none'}
        </b>
        <span className="sub">
          {lostN
            ? [
                lost.length ? `${lost.length} print${lost.length === 1 ? '' : 's'} that did not finish` : null,
                partFails.length ? `${partFails.length} object${partFails.length === 1 ? '' : 's'} failed on a plate` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : 'every print came off'}
        </span>
      </div>
    </div>
  )
}

function RunLog({
  ctx,
  detail,
  money,
  busy,
  onChanged,
  setError,
  platesAbove = false,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  money: (n: number) => string
  busy: boolean
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
  /** The Plates list is on this page, so a print from a file is listed
   *  there, under its file, and not a second time here (CG, 15 Oct). */
  platesAbove?: boolean
}) {
  const [mode, setMode] = useState<'none' | 'run' | 'work'>('none')
  const [saving, setSaving] = useState(false)
  const sliceIds = new Set(detail.slices.map((x) => x.id))
  const fromPlates = platesAbove ? detail.runs.filter((r) => r.sliceImportId && sliceIds.has(r.sliceImportId)) : []
  const looseRuns = platesAbove ? detail.runs.filter((r) => !fromPlates.includes(r)) : detail.runs

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
  const printing = canPrint(detail.phase, detail.facts.kind)
  const [work, setWork] = useState({
    kind: hoursKind(detail.phase, detail.facts.kind) as WorkKind,
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
          {printing && (
            <button type="button" className="btn sm" disabled={busy} onClick={() => setMode('run')}>
              Record a build run
            </button>
          )}
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
                Machine time
              </label>
              <HoursInput
                id="r-hours"
                label="Machine time"
                value={run.hours}
                onChange={(hours) => setRun((r) => ({ ...r, hours: hours ?? 0 }))}
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
                Time
              </label>
              <HoursInput
                id="w-hours"
                label="Time"
                value={Number(work.hours) || null}
                onChange={(hours) => setWork((w) => ({ ...w, hours: hours == null ? '' : String(hours) }))}
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
          <TookTotals ctx={ctx} detail={detail} money={money} fromPlates={fromPlates.length} />
          {looseRuns.map((r) => (
            <PrintLine
              key={r.id}
              run={r}
              parts={detail.parts}
              busy={saving}
              onRemove={(undo) => guard(() => deletePrintRun(ctx.shop.id, r.id, undo))}
            />
          ))}
          {detail.work.map((w) => (
            <div key={w.id} className="histitem">
              <span style={{ color: 'var(--info)' }}>◷</span>
              <span style={{ color: 'var(--txt)' }}>
                {fmtHours(Number(w.hours))} {WORK_KIND_LABEL[w.kind].toLowerCase()}
              </span>
              <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>
                {w.workedOn}
                {w.actor ? ` · ${w.actor}` : ''}
              </span>
              <button
                type="button"
                className="linkbtn"
                style={{ marginLeft: 'auto', fontSize: 11, width: 'auto', marginTop: 0 }}
                disabled={saving}
                onClick={() => void guard(() => deleteWorkEntry(ctx.shop.id, w.id))}
              >
                remove
              </button>
              {w.note && <div className="histnote">{w.note}</div>}
            </div>
          ))}
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
  onSkip,
}: {
  item: ResolvedGateItem
  onToggle: (checked: boolean) => void
  onNote: (text: string) => void
  /** Skip with a reason, or null to take a skip back. */
  onSkip: (reason: string | null) => void
}) {
  const id = `g-${item.key}`
  const [skipping, setSkipping] = useState(false)
  const [why, setWhy] = useState('')
  // An unticked item is the only thing on this row that matters, so it is
  // the only thing given weight. Ticked items stay legible and quiet --
  // they are evidence, not a to-do list.
  const todo = !item.checked
  if (item.skipped) {
    return (
      <div className="gwrap">
        <div className="gitem">
          <span aria-hidden="true" style={{ width: 16, color: 'var(--warn)' }}>
            ↷
          </span>
          <span className="lab">{item.label}</span>
          <span className="gwho">skipped</span>
        </div>
        <div className="hint" style={{ paddingLeft: 24, marginTop: 0, color: 'var(--warn)' }}>
          Skipped — {item.skipped}{' '}
          <button type="button" className="linkbtn" style={{ width: 'auto' }} onClick={() => onSkip(null)}>
            take the skip back
          </button>
        </div>
      </div>
    )
  }
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
        <span className="gwho">
          {todo && !skipping ? (
            <button
              type="button"
              className="linkbtn"
              style={{ width: 'auto', fontSize: 11 }}
              aria-label={`Skip ${item.label}`}
              onClick={() => setSkipping(true)}
            >
              skip
            </button>
          ) : item.automatic ? (
            item.autoFrom
          ) : item.checked ? (
            'ticked'
          ) : (
            ''
          )}
        </span>
      </div>
      <div className="hint" style={{ paddingLeft: 24, marginTop: 0 }}>
        {item.why}
      </div>
      {/* Voltage's rule: a gate is satisfied or skipped with a reason. */}
      {skipping && (
        <div className="btnrow" style={{ paddingLeft: 24, marginTop: 6, alignItems: 'flex-end' }}>
          <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220 }}>
            <label className="lbl" htmlFor={`skip-${item.key}`}>
              Why skip it? (goes on the record)
            </label>
            <input
              id={`skip-${item.key}`}
              value={why}
              autoFocus
              onChange={(e) => setWhy(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn sm"
            disabled={!why.trim()}
            onClick={() => {
              onSkip(why)
              setSkipping(false)
              setWhy('')
            }}
          >
            Skip it
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setSkipping(false)}>
            Cancel
          </button>
        </div>
      )}
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
          thing it is reading. */}
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
  const groups = newestFirst(groupSliceFiles(detail.slices, detail.runs), detail.runs)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  if (groups.length === 0 || !canPrint(detail.phase, detail.facts.kind)) return null

  const hrs = (h: number | null) => fmtHours(h)
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
    await markPlatePrinted(ctx.shop.id, detail.jobId, ctx.profile.id, g.first.id)
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
                        ✓ {g.usedUnits} g · {fmtHours(g.usedHours)}
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
  stages,
  busy,
  onMove,
  onCancel,
}: {
  stages: { value: JobPhase; label: string }[]
  busy: boolean
  onMove: (to: JobPhase, why: string) => Promise<void>
  onCancel: () => void
}) {
  const [to, setTo] = useState<JobPhase>(stages[stages.length - 1].value)
  const [why, setWhy] = useState('')
  const name = stages.find((x) => x.value === to)?.label ?? to
  return (
    <div className="gatebox">
      <div className="btnrow" style={{ alignItems: 'flex-end', margin: 0 }}>
        <div className="fld" style={{ margin: 0, width: 180 }}>
          <label className="lbl" htmlFor="move-back-to">
            Move back to
          </label>
          <select id="move-back-to" value={to} onChange={(e) => setTo(e.target.value as JobPhase)}>
            {stages.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 240 }}>
          <label className="lbl" htmlFor="move-back-why">
            What needs fixing? (required — it goes in Activity)
          </label>
          <input
            id="move-back-why"
            value={why}
            autoFocus
            placeholder="Coastline off by a layer, client wants a change, failed QC…"
            onChange={(e) => setWhy(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn sm primary"
          disabled={busy || !why.trim()}
          onClick={() => void onMove(to, why)}
        >
          Move back to {name}
        </button>
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * Which series this piece belongs to. One select: file it, move it, or take
 * it out -- each logged to Activity. The series page is where the pieces
 * are seen together.
 */
function SeriesSection({
  ctx,
  jobId,
  seriesId,
  all,
  client = false,
  busy,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  jobId: string
  seriesId: string | null
  all: SeriesRow[]
  /** A client's project: the series groups it with related work. */
  client?: boolean
  busy: boolean
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const options = all
    .filter((s) => !s.archivedAt || s.id === seriesId)
    .map((s) => ({ id: s.id, label: seriesPath(all, s.id) ?? s.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return (
    <section className="sec" style={{ marginTop: 18 }}>
      <div className="sechead">
        <h4>Series</h4>
        <span className="secstat">
          {seriesId ? (
            <Link to={`/series/${seriesId}`}>{seriesPath(all, seriesId)}</Link>
          ) : (
            'not in a series'
          )}
        </span>
      </div>
      <div className="btnrow" style={{ alignItems: 'center' }}>
        <label className="lbl" htmlFor="piece-series" style={{ margin: 0 }}>
          Piece of
        </label>
        <select
          id="piece-series"
          value={seriesId ?? ''}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value || null
            void (async () => {
              try {
                await setJobSeries(ctx.shop.id, jobId, next, ctx.profile.id)
                await onChanged()
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              }
            })()
          }}
        >
          <option value="">No series</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <Link to="/series" className="linkbtn" style={{ width: 'auto' }}>
          {all.length ? 'All series' : 'Start a series'}
        </Link>
      </div>
      {client && (
        <div className="hint" style={{ marginTop: 6 }}>
          Files this order with related work — a BathyTopo commission alongside your own BathyTopo
          pieces, say. It stays this client&rsquo;s project: their quote, invoice and stages are
          unchanged.
        </div>
      )}
    </section>
  )
}

/** The approval items a shop may move past with a written reason. */
const GO_AHEAD_KEYS = ['accepted', 'deposit']

/**
 * "Go ahead without acceptance or deposit". Shown only while one of the two
 * is outstanding. A reason is required; nothing happens without one.
 */
function GoAheadWithout({
  items,
  busy,
  onGo,
}: {
  items: ResolvedGateItem[]
  busy: boolean
  onGo: (why: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [why, setWhy] = useState('')
  const money = items.filter((i) => GO_AHEAD_KEYS.includes(i.key) && !i.checked)
  if (money.length === 0) return null
  const rest = items.filter((i) => !GO_AHEAD_KEYS.includes(i.key) && !i.checked)
  const what = money.map((i) => (i.key === 'accepted' ? 'acceptance' : 'deposit')).join(' or ')
  if (!open) {
    return (
      <div className="btnrow" style={{ marginBottom: 8 }}>
        <button type="button" className="btn sm" disabled={busy} onClick={() => setOpen(true)}>
          Go ahead without {what}…
        </button>
      </div>
    )
  }
  return (
    <div className="attn warn" style={{ marginBottom: 10 }}>
      <div className="fld" style={{ margin: 0 }}>
        <label className="lbl" htmlFor="go-ahead-why">
          Why go ahead without {what}? (goes on the record and stays on the board)
        </label>
        <textarea
          id="go-ahead-why"
          rows={2}
          value={why}
          autoFocus
          onChange={(e) => setWhy(e.target.value)}
          placeholder="e.g. Repeat client, PO promised Friday; deposit on delivery agreed by phone with Kai"
        />
      </div>
      {rest.length > 0 && (
        <div className="hint" style={{ marginTop: 6 }}>
          This records the reason, but it will not move yet — still open:{' '}
          {rest.map((i) => i.label).join('; ')}.
        </div>
      )}
      <div className="btnrow" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn sm"
          disabled={busy || !why.trim()}
          onClick={() => {
            onGo(why)
            setOpen(false)
            setWhy('')
          }}
        >
          {rest.length > 0 ? 'Record the reason' : 'Go ahead'}
        </button>
        <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * Estimated build: what the build sheet will cost to make and what it
 * earns, before a single print (CG, 8 Oct). Replaces "What it actually
 * took" until In build -- an "actual" column with nothing in it, and a
 * Log hours button, are noise at a stage where nothing has run.
 *
 * Both columns are priced the same way, at the quote's own frozen rates:
 * "Quoted" is the quote as it stands, "Build sheet" the same quote with
 * the sheet's copies. Recomputed on every edit to a part. The quote itself
 * is not changed behind the client: a sent or accepted price is what they
 * agreed to, so the difference goes into a revision -- one click, copies
 * already in it, "they added parts or copies" already chosen.
 */
function EstimatedBuild({
  ctx,
  detail,
  money,
  jobId,
  inRecord,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  money: (n: number) => string
  jobId: string
  inRecord: boolean
}) {
  const q = detail.quoteInputs
  const pctx = { rateCard: ctx.rateCard, shop: ctx.shop, materials: ctx.materials, printers: ctx.printers }
  const asQuoted = q ? priceProjectQuote(detail, pctx) : null
  if (!q || !asQuoted) {
    return (
      <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
        There is no priced quote to estimate from yet.
      </div>
    )
  }
  const sheet = sheetVsQuote(q.builds ?? [], q.quantity, detail.parts)
  const asBuilt = sheet.changed
    ? (priceProjectQuote(detail, pctx, { builds: sheet.builds, quantity: sheet.quantity }) ?? asQuoted)
    : asQuoted
  const changed = sheet.changed
  const a = estimateOf(asQuoted.priced, asQuoted.rates)
  const b = estimateOf(asBuilt.priced, asBuilt.rates)
  const unit = asQuoted.unit
  const diff = asBuilt.priced.total - asQuoted.priced.total
  const status = detail.facts.quoteStatus
  const loose = [
    ...sheet.unpriced.map((l) => `${l} (no sliced numbers)`),
    ...sheet.quotedOnly.map((l) => `${l} (on the quote, not the build sheet)`),
  ]
  const delta = (x: number, y: number) => {
    const d = Math.round((y - x) * 100) / 100
    return Math.abs(d) < 0.005 ? '—' : `${d > 0 ? '+' : '−'}${money(Math.abs(d))}`
  }
  const copies = (n: number) => `${n} cop${n === 1 ? 'y' : 'ies'}`

  return (
    <>
      <div className={changed ? 'attn warn' : 'hint'} data-testid="sheet-price" style={{ marginTop: 0, marginBottom: 10 }}>
        {changed ? (
          <>
            <strong>The build sheet now prices at {money(asBuilt.priced.total)}</strong> — {copies(sheet.sheetCopies)}{' '}
            against {sheet.quotedCopies} quoted at {money(asQuoted.priced.total)} ({delta(asQuoted.priced.total, asBuilt.priced.total)}).
          </>
        ) : (
          <>
            The build sheet matches the quote: {copies(sheet.sheetCopies)}, {money(asQuoted.priced.total)}.
          </>
        )}
        {sheet.added.length > 0 && <> New from their own files: {sheet.added.join(', ')}.</>}
        {loose.length > 0 && <> Not repriced: {loose.join('; ')}.</>}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Cost to make it</th>
              <th className="r">{changed ? 'Quoted' : 'Estimate'}</th>
              {changed && <th className="r">Build sheet</th>}
              {changed && <th className="r">Difference</th>}
            </tr>
          </thead>
          <tbody>
            {a.lines.map((l, i) => {
              const m = b.lines[i]
              return (
                <tr key={l.key}>
                  <td>
                    <div style={{ color: 'var(--txt)' }}>{l.label}</div>
                    <div className="pmeta" style={{ whiteSpace: 'normal' }}>
                      {l.key === 'material'
                        ? `${Math.round(asBuilt.priced.totalUnits).toLocaleString()}${unit} on the build sheet`
                        : l.key === 'machine' || l.key === 'wear'
                          ? `${fmtHours(asBuilt.priced.machineHours)} of machine time on the build sheet`
                          : 'Design and finishing, at the hours quoted'}
                    </div>
                  </td>
                  <td className="r mono">{money(l.quoted)}</td>
                  {changed && <td className="r mono">{money(m.quoted)}</td>}
                  {changed && <td className="r mono">{delta(l.quoted, m.quoted)}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="grid3" style={{ marginTop: 12 }}>
        <Stat
          label="They pay (before tax)"
          value={money(b.netRevenue)}
          sub={changed ? `quoted ${money(a.netRevenue)}` : undefined}
        />
        <Stat
          label="Cost to make it"
          value={money(b.quotedCost)}
          sub={changed ? `quoted ${money(a.quotedCost)}` : undefined}
        />
        <Stat
          label="Estimated margin"
          value={money(b.quotedMargin)}
          tone={b.quotedMargin < 0 ? 'crit' : ''}
          sub={changed ? `quoted ${money(a.quotedMargin)}` : 'before anything is printed'}
        />
      </div>

      {!inRecord && changed && (
        <div className="btnrow" style={{ marginTop: 12, alignItems: 'center' }}>
          <Link to={`/intake?revise=${jobId}&from=sheet`} className="btn sm" style={{ textDecoration: 'none' }}>
            Revise the quote to match
          </Link>
          <span className="hint" style={{ margin: 0 }}>
            {Math.abs(diff) < 0.005
              ? 'Same price, different copies -- revise so the quote says what is being made.'
              : status === 'accepted'
                ? 'The client accepted the old price. The new one is a revision they see and agree to.'
                : 'The quote stays as sent until you revise it.'}
          </span>
        </div>
      )}
    </>
  )
}

/** A priced quote's cost lines and margin, with nothing recorded against
 *  it -- the "quoted" half of the variance, on its own. */
function estimateOf(p: PricedQuote, rates: RateSet) {
  return compareToQuote(p, NO_ACTUALS, rates)
}

const NO_ACTUALS: ProjectActuals = {
  materialUnits: 0, failedUnits: 0, materialCost: 0, machineHours: 0, machineCost: 0, wearCost: 0,
  powerCost: 0, runs: 0, failedRuns: 0, designHours: 0, finishingHours: 0, adminHours: 0,
}

/** Scheduled's two checks, made once per render: the spool against the
 *  build sheet, and the start-by date against today. */
function schedulePlan(
  detail: ProjectDetail,
  stock: MaterialRow[],
  failurePct: number | null,
  holds: StockHoldRow[] = [],
) {
  const q = detail.quoteInputs
  const sheet = q ? sheetVsQuote(q.builds ?? [], q.quantity, detail.parts) : null
  const material = materialCheck(
    sheet?.builds ?? [],
    q && !(q.builds ?? []).length ? { materialId: q.materialId, quantity: sheet?.quantity ?? q.quantity, unitsPerPart: q.unitsPerPart } : null,
    stock.filter((m) => !m.archived).map((m) => ({ id: m.id, name: m.name, unit: m.unit, onHand: m.onHand })),
    failurePct,
    holds,
    detail.jobId,
  )
  const start = startBy({
    neededBy: detail.facts.neededBy,
    deliveryHow: detail.facts.deliveryHow,
    parts: detail.parts,
    quote: detail.quoteInputs,
  })
  const slotOk =
    start.status === 'late' ? false : start.status === 'ok' || start.status === 'soon' || start.status === 'done' ? true : null
  // The machine the files were sliced for, most copies first.
  const sliced = new Map<string, number>()
  for (const b of sheet?.builds ?? []) if (b.printerId) sliced.set(b.printerId, (sliced.get(b.printerId) ?? 0) + b.qty)
  const slicedFor = [...sliced.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? q?.printerId ?? null
  return { material, slotOk, start, slicedFor }
}

/**
 * Scheduled (CG, 8 Oct): pick the machine, and see whether the spool on
 * the shelf covers the build sheet. Both answer gate items directly --
 * "a machine picked" ticks when one is, "enough material" ticks when every
 * spool covers it -- so the checklist below stops being an honour system.
 */
function MachineAndMaterial({
  ctx,
  detail,
  plan,
  rows,
  busy,
  onPick,
  holds,
  onHold,
  onStocked,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  plan: ReturnType<typeof schedulePlan>
  rows: JobListRow[]
  busy: boolean
  onPick: (printerId: string | null) => void
  holds: StockHoldRow[]
  onHold: (h: { materialId: string; units: number }[]) => void
  onStocked: () => void
}) {
  /** The spool with "add stock" open under it. */
  const [stocking, setStocking] = useState<string | null>(null)
  const [stocked, setStocked] = useState<string | null>(null)
  const picked = detail.facts.printerId
  const name = (id: string | null) => ctx.printers.find((p) => p.id === id)?.name ?? null
  const alsoOn = picked
    ? rows.filter(
        (r) =>
          r.jobId !== detail.jobId &&
          r.facts.printerId === picked &&
          (r.facts.phase === 'scheduled' || r.facts.phase === 'building'),
      )
    : []
  const m = plan.material
  const heldAny = holds.some((h) => h.jobId === detail.jobId)
  const othersOn = (materialId: string) =>
    holds
      .filter((h) => h.materialId === materialId && h.jobId !== detail.jobId && h.remaining > 0)
      .map((h) => `${h.ref} ${h.title}: ${Math.round(h.remaining)}`)
      .join('\n')
  return (
    <>
      <div className="fld" style={{ maxWidth: 360 }}>
        <label className="lbl" htmlFor="sched-printer">
          Machine it will run on
        </label>
        <select
          id="sched-printer"
          value={picked ?? ''}
          disabled={busy}
          onChange={(e) => onPick(e.target.value || null)}
        >
          <option value="">Not picked yet</option>
          {ctx.printers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.model ? ` — ${p.model}` : ''}
              {p.id === plan.slicedFor ? ' (sliced for this)' : ''}
            </option>
          ))}
        </select>
      </div>
      {picked && (
        <div className="hint" style={{ marginTop: 4 }} data-testid="machine-load">
          {alsoOn.length === 0
            ? `Nothing else is booked on ${name(picked)}.`
            : `Also booked on ${name(picked)}: ${alsoOn
                .map((r) => `${r.ref} ${r.title} (${r.facts.phase === 'building' ? 'In build' : 'Scheduled'})`)
                .join('; ')}. Check the two fit before the start-by date.`}
          {plan.slicedFor && picked !== plan.slicedFor && (
            <span style={{ color: 'var(--warn)' }}>
              {' '}
              The files were sliced for {name(plan.slicedFor) ?? 'another machine'}; times on another machine can be
              out by a fifth. Re-slice for {name(picked)} if it matters.
            </span>
          )}
        </div>
      )}

      <div style={{ overflowX: 'auto', marginTop: 12 }} data-testid="material-check">
        {m.lines.length === 0 ? (
          <div className="hint">
            The build sheet has no grams to check against the shelf — tick the material item by hand once you
            have looked.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Spool</th>
                <th className="r">Needed</th>
                <th className="r">{m.failurePct ? `With ${m.failurePct}% failures` : 'With failures'}</th>
                <th className="r">On hand</th>
                <th className="r">Set aside for others</th>
                <th className="r">Available</th>
                <th className="r">Set aside here</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {m.lines.map((l) => (
                <Fragment key={l.materialId}>
                <tr>
                  <td>
                    {l.name}
                    {!busy && (
                      <div>
                        <button
                          type="button"
                          className="linkbtn"
                          style={{ width: 'auto', fontSize: 11 }}
                          aria-label={`Add stock of ${l.name}`}
                          onClick={() => setStocking(stocking === l.materialId ? null : l.materialId)}
                        >
                          {stocking === l.materialId ? 'close' : '+ add stock'}
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="r mono">
                    {l.need.toLocaleString()}
                    {l.unit}
                  </td>
                  <td className="r mono">
                    {l.needWithFailures.toLocaleString()}
                    {l.unit}
                  </td>
                  <td className="r mono">
                    {Math.round(l.onHand).toLocaleString()}
                    {l.unit}
                  </td>
                  <td className="r mono" title={othersOn(l.materialId)}>
                    {l.heldElsewhere ? `${l.heldElsewhere.toLocaleString()}${l.unit}` : '—'}
                  </td>
                  <td className="r mono">
                    {l.available.toLocaleString()}
                    {l.unit}
                  </td>
                  <td className="r mono">{l.heldHere ? `${l.heldHere.toLocaleString()}${l.unit}` : '—'}</td>
                  <td style={{ color: !l.ok ? 'var(--red)' : l.setAside ? 'var(--ok)' : 'var(--warn)' }}>
                    {!l.ok
                      ? `short ${(l.needWithFailures - l.available).toLocaleString()}${l.unit}`
                      : l.setAside
                        ? 'set aside'
                        : 'covered, not set aside'}
                  </td>
                </tr>
                {stocking === l.materialId && (
                  <tr>
                    <td colSpan={8} style={{ background: 'var(--panel-2)' }}>
                      <AddStock
                        shopId={ctx.shop.id}
                        actorId={ctx.profile.id}
                        material={{ id: l.materialId, name: l.name, unit: l.unit, onHand: l.onHand }}
                        onDone={(said) => {
                          setStocked(said)
                          setStocking(null)
                          onStocked()
                        }}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {stocked && (
          <div className="hint" role="status" style={{ color: 'var(--ok)', marginTop: 6 }}>
            {stocked}
          </div>
        )}
        {m.lines.length > 0 && !busy && (
          <div className="btnrow" style={{ marginTop: 8, alignItems: 'center' }}>
            {m.ok && !m.allSetAside && (
              <button
                type="button"
                className="btn sm"
                onClick={() => onHold(m.lines.map((l) => ({ materialId: l.materialId, units: l.needWithFailures })))}
              >
                {heldAny ? 'Update what is set aside' : 'Set aside for this project'}
              </button>
            )}
            {heldAny && (
              <button type="button" className="linkbtn" style={{ width: 'auto' }} onClick={() => onHold([])}>
                release it
              </button>
            )}
            <span className="hint" style={{ margin: 0 }}>
              {m.ok === false
                ? 'Not enough is free to set aside. Add stock on the short spool above, or skip the material item with a reason.'
                : m.allSetAside
                  ? 'Held for this project: other projects see it as taken. It is drawn down as prints are recorded and released when the project is delivered.'
                  : 'Setting it aside takes it out of what every other project sees as available.'}
            </span>
          </div>
        )}
        <div className="hint" style={{ marginTop: 6 }}>
          From the build sheet&apos;s copies.{' '}
          {m.failurePct
            ? `Failures at the shop's own ${m.failurePct}% rate.`
            : 'No failure rate is set in Shop settings, so there is no allowance for failed prints in this.'}{' '}
          Available is on hand less what other live projects have set aside. On hand is kept in{' '}
          <Link to="/settings">Settings → Materials</Link>.
          {m.unassigned > 0 && ` ${m.unassigned.toLocaleString()}g on lines with no spool set is not counted.`}
        </div>
      </div>
    </>
  )
}

/** Where a history line says copies went. */
const COPY_MOVE_LABEL: Record<PartStatus, string> = {
  pending: 'not printed',
  printed: 'printed',
  passed: 'passed QC',
  reprint: 'failed, going back',
}

/**
 * One box per copy, in copy order, so "1 of 5" is seen rather than read
 * and copy 3 is always the third box. Past a dozen copies the boxes stop
 * helping and the line below carries it alone.
 */
function CopyBar({ states, queued }: { states: PartStatus[]; queued?: Set<number> }) {
  if (states.length > 12) return null
  const cls: Record<PartStatus, string> = { pending: '', printed: 'on', passed: 'ok', reprint: 'fail' }
  return (
    <span className="copybar" aria-hidden="true">
      {states.map((st, i) =>
        queued?.has(i) ? (
          <i key={i} className="queued" title={`Copy ${i + 1}: reprint queued`} />
        ) : (
          <i key={i} className={cls[st]} title={`Copy ${i + 1}: ${COPY_MOVE_LABEL[st]}`} />
        ),
      )}
    </span>
  )
}

/** What a copy can be set to at this stage. "Not printed" is always there:
 *  it is how a copy marked by mistake goes back (CG, 8 Oct). Before
 *  anything prints, and once delivered, the list is read-only. */
function copyOptions(phase: JobPhase, kind: ProjectDetail["facts"]["kind"]): PartStatus[] {
  const allowed = allowedStatuses(phase, kind)
  if (allowed.length === 0) return []
  const order: PartStatus[] = ['pending', 'printed', 'passed', 'reprint']
  // A copy that passed in Review can still be set back to printed there.
  const set = new Set<PartStatus>(['pending', 'printed', ...allowed])
  return order.filter((s) => set.has(s))
}

/** The newest reason given for a copy going back, from the part's history. */
function copyReason(part: PartRow, copy: number): string | null {
  const ev = part.history.find(
    (h) => h.kind === 'status' && h.toStatus === 'reprint' && (h.copies ?? []).includes(copy + 1),
  )
  return ev?.note?.trim() || null
}

/**
 * One copy's story, from the part's history: every time it failed, and the
 * file it is being reprinted from. A failed copy given a new file used to
 * read just "Not printed" -- the failure gone from the card, the file
 * nowhere near it (CG, 9 Oct). Voltage kept a failed part as a permanent
 * record beside its replacement; this keeps it beside the copy.
 */
export function copyStory(
  part: PartRow,
  copy: number,
  fileName: (sliceImportId: string) => string | null,
): { fails: { note: string | null; at: string }[]; file: string | null } {
  const evs = [...part.history]
    .reverse()
    .filter((h) => h.kind === 'status' && (h.copies ?? []).includes(copy + 1))
  let file: string | null = null
  const fails: { note: string | null; at: string }[] = []
  for (const h of evs) {
    if (h.toStatus === 'reprint') {
      fails.push({ note: h.note?.trim() || null, at: h.at })
      file = null
    } else if (h.sliceImportId) file = fileName(h.sliceImportId) ?? 'a file since removed'
  }
  return { fails, file }
}

const COPY_SHORT: Record<PartStatus, string> = {
  pending: 'Not printed',
  printed: 'Printed',
  passed: 'Passed',
  reprint: 'Failed',
}

/**
 * Each copy of a part, as a card with its own state (CG, 8 Oct).
 *
 * One click per change: the state is a row of buttons, not a dropdown to
 * open and read. Failing asks why, on the card. A failed copy gets its
 * three ways forward right there -- a fixed file (back in the queue to
 * print from it), skip it (not printed again; the part needs one fewer),
 * or simply back to not printed -- so nobody has to go looking for them.
 */
function EachCopy({
  part,
  options,
  busy,
  onSet,
  onNewFile,
  onSkip,
  onClose,
  fileName = () => null,
}: {
  part: PartRow
  options: PartStatus[]
  busy: boolean
  onSet: (copies: number[], to: PartStatus, why: string | null) => Promise<void>
  onNewFile: (copy: number, file: File) => Promise<void>
  onSkip: (copy: number, why: string | null) => Promise<void>
  onClose: () => void
  fileName?: (sliceImportId: string) => string | null
}) {
  const states = statesOf(part)
  const [failing, setFailing] = useState<number | null>(null)
  const [skipping, setSkipping] = useState<number | null>(null)
  const [why, setWhy] = useState('')
  const editable = options.length > 0
  const made = states.map((s, i) => (s === 'pending' ? -1 : i)).filter((i) => i >= 0)
  return (
    <div className="eachcopy" data-testid={`each-copy-${part.id}`}>
      <div className="copygrid">
        {states.map((st, i) => {
          const story = copyStory(part, i, fileName)
          const queued = st === 'pending' && !!story.file
          // The failures already behind this copy. A copy that is failed
          // right now shows its newest reason below, with its ways forward.
          const past = st === 'reprint' ? story.fails.slice(0, -1) : story.fails
          return (
          <div key={i} className={`copycard ${st}${queued ? ' queued' : ''}`}>
            <div className="copyhead">
              <span className="copyno">Copy {i + 1}</span>
              <span className={`copypill ${queued ? 'queued' : st}`}>{queued ? 'Reprint queued' : COPY_SHORT[st]}</span>
            </div>
            {past.length > 0 && (
              <div className="copytrail">
                {past.slice(-2).map((f, k) => (
                  <div key={k} className="copyfailed">
                    ✕ {st === 'printed' || st === 'passed' ? 'Failed earlier' : 'Failed'}
                    {past.length > 1 ? ` (attempt ${past.length - Math.min(2, past.length) + k + 1})` : ''}
                    {f.note ? ` — ${f.note}` : ''}
                  </div>
                ))}
                {past.length > 2 && <div className="copyfailed">+{past.length - 2} earlier</div>}
                {/* CG, 24 Oct: a failure above a Printed pill read as if the
                    copy were failed now. It is history: say what came after. */}
                {(st === 'printed' || st === 'passed') && !story.file && (
                  <div className="copyfile">✓ Printed again after that — this copy is done</div>
                )}
              </div>
            )}
            {story.file && st !== 'reprint' && (
              <div className="copyfile">
                ↻ {st === 'pending' ? 'Reprinting from' : 'Reprinted from'} <b>{story.file}</b>
              </div>
            )}
            {editable && (
              <div className="seg" role="group" aria-label={`Copy ${i + 1} of ${part.label}`}>
                {(options.includes(st) ? options : [...options, st]).map((o) => (
                  <button
                    key={o}
                    type="button"
                    className={`segbtn ${o} ${st === o ? 'on' : ''}`.trim()}
                    aria-pressed={st === o}
                    disabled={busy || st === o}
                    onClick={() => {
                      setSkipping(null)
                      if (o === 'reprint') {
                        setFailing(i)
                        setWhy('')
                        return
                      }
                      setFailing(null)
                      void onSet([i], o, null)
                    }}
                  >
                    {COPY_SHORT[o]}
                  </button>
                ))}
              </div>
            )}
            {failing === i && (
              <div className="copyform">
                <input
                  aria-label={`Why did copy ${i + 1} fail?`}
                  placeholder="What went wrong"
                  value={why}
                  autoFocus
                  onChange={(e) => setWhy(e.target.value)}
                />
                <div className="btnrow">
                  <button
                    type="button"
                    className="btn sm danger"
                    disabled={busy || !why.trim()}
                    onClick={() =>
                      void onSet([i], 'reprint', why).then(() => {
                        setFailing(null)
                        setWhy('')
                      })
                    }
                  >
                    Mark it failed
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setFailing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {st === 'reprint' && failing !== i && (
              <>
                {copyReason(part, i) && <div className="copywhy">↩ {copyReason(part, i)}</div>}
                {editable && skipping !== i && (
                  <div className="failacts">
                    <label className="btn sm" style={busy ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
                      New file…
                      <input
                        type="file"
                        accept={SLICE_ACCEPT}
                        aria-label={`New file for copy ${i + 1} of ${part.label}`}
                        disabled={busy}
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          e.target.value = ''
                          if (f) void onNewFile(i, f)
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={busy || states.length <= 1}
                      title={states.length <= 1 ? 'The only copy — remove the part instead.' : undefined}
                      onClick={() => {
                        setSkipping(i)
                        setWhy('')
                      }}
                    >
                      Skip
                    </button>
                  </div>
                )}
                {skipping === i && (
                  <div className="copyform">
                    <div className="pmeta" style={{ margin: 0 }}>
                      Not printed again — the part goes from {states.length} to {states.length - 1} copies.
                    </div>
                    <input
                      aria-label={`Why skip copy ${i + 1}?`}
                      placeholder="Why (optional) — client only needs four"
                      value={why}
                      onChange={(e) => setWhy(e.target.value)}
                    />
                    <div className="btnrow">
                      <button
                        type="button"
                        className="btn sm danger"
                        disabled={busy}
                        onClick={() => void onSkip(i, why.trim() || null).then(() => setSkipping(null))}
                      >
                        Skip copy {i + 1}
                      </button>
                      <button type="button" className="btn sm ghost" onClick={() => setSkipping(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          )
        })}
      </div>
      <div className="copyfoot">
        {editable && made.length > 0 && (
          <button
            type="button"
            className="linkbtn"
            disabled={busy}
            onClick={() => void onSet(made, 'pending', null)}
          >
            set every copy back to not printed
          </button>
        )}
        <button type="button" className="linkbtn" onClick={onClose}>
          close ▴
        </button>
      </div>
    </div>
  )
}

/**
 * A revision made after the client accepted -- from In build, say, when
 * copies changed (CG, 12 Oct). The price that counts stays the accepted one
 * until they accept this. Quote status is otherwise set only in Approval,
 * so without this a revision made later could never be agreed.
 */
function PendingRevision({
  detail,
  money,
  busy,
  onMark,
}: {
  detail: ProjectDetail
  money: (n: number) => string
  busy: boolean
  onMark: (status: QuoteStatus) => void
}) {
  const q = detail.quote
  if (!q || (q.status !== 'draft' && q.status !== 'sent') || detail.facts.quoteStatus !== 'accepted') return null
  return (
    <div className="attn warn" data-testid="pending-revision" style={{ marginTop: 12 }}>
      <span>
        <strong>
          A revised quote{q.total != null ? ` at ${money(q.total)}` : ''} is {q.status === 'sent' ? 'with the client' : 'not sent yet'}
        </strong>
        . Until they accept it, the price that counts is the one they agreed
        {detail.facts.quoteTotal != null ? `: ${money(detail.facts.quoteTotal)}` : ''}.
      </span>
      <span className="btnrow" style={{ margin: 0 }}>
        <Link to={`/quote/${q.id}/print`} className="btn sm" style={{ textDecoration: 'none' }}>
          See it
        </Link>
        {q.status === 'draft' && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => onMark('sent')}>
            Mark it sent
          </button>
        )}
        <button type="button" className="btn sm primary" disabled={busy} onClick={() => onMark('accepted')}>
          Client accepted it
        </button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={() => onMark('declined')}>
          Declined
        </button>
      </span>
    </div>
  )
}

/**
 * The copies one recorded print moved that are still where it put them --
 * what removing it would put back. 1-based, per part.
 */
/**
 * One recorded print, said once (CG, 15 Oct: "tough to understand what has
 * been imported versus printed versus what it took"). A print that came
 * from a file is listed under that file's plate; one with no file is listed
 * in What it took. Removing it asks whether the copies it marked go back.
 */
function PrintLine({
  run: r,
  parts,
  busy,
  onRemove,
  onCorrect,
  showFile,
  hideMarks = false,
}: {
  run: PrintRunRow
  parts: PartRow[]
  /** Your own work tracks pieces in Made, not copies on a parts list. */
  hideMarks?: boolean
  busy: boolean
  onRemove: (undoCopies: boolean) => Promise<void>
  onCorrect?: () => void
  /** Say which file it came from -- only where the plate is not the heading. */
  showFile?: string | null
}) {
  const [removing, setRemoving] = useState(false)
  const [undoCopies, setUndoCopies] = useState(true)
  const marked = hideMarks ? [] : runMarks(parts, r.id)
  const n = marked.reduce((a, m) => a + m.copies.length, 0)
  const how =
    r.outcome === 'success'
      ? r.failureReason
        ? 'came off, some objects failed'
        : 'came off clean'
      : r.outcome === 'failed'
        ? 'failed'
        : 'stopped part way'
  // The note "From <file>" says nothing under the file's own heading.
  const note = r.note && r.note !== r.failureReason && !/^From [^—]*$/.test(r.note.trim()) ? r.note : null
  return (
    <div className="histitem" data-testid={`print-${r.id}`}>
      <span
        style={{
          color: r.outcome === 'failed' ? 'var(--red)' : r.outcome === 'cancelled' ? 'var(--warn)' : 'var(--ok)',
        }}
      >
        {r.outcome === 'success' ? '✓' : r.outcome === 'failed' ? '✕' : '−'}
      </span>
      <span style={{ color: 'var(--txt)' }}>
        {r.startedAt ? `${r.startedAt.slice(0, 10)} · ` : ''}
        {how} · {fmtHours(r.hours ?? 0)} · {r.unitsUsed ?? 0} {r.unit ?? 'g'}
      </span>
      <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>
        {r.printerName ?? 'machine gone'} · {r.materialName ?? 'material gone'}
        {r.operator ? ` · ${r.operator}` : ''}
        {showFile ? ` · ${showFile}` : ''}
        {marked.length > 0 &&
          ` · ${r.outcome === 'success' ? 'printed' : 'failed'} ${marked
            .map((m) => `${m.label} #${m.copies.join(', #')}`)
            .join('; ')}`}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
        {onCorrect && (
          <button
            type="button"
            className="linkbtn"
            style={{ fontSize: 11, width: 'auto', marginTop: 0 }}
            disabled={busy}
            aria-label={`Correct the print of ${r.startedAt?.slice(0, 10) ?? 'unknown date'}`}
            title="Fix what was recorded — it stopped part way, the grams were off — without removing it."
            onClick={onCorrect}
          >
            correct
          </button>
        )}
        <button
          type="button"
          className="linkbtn"
          style={{ fontSize: 11, width: 'auto', marginTop: 0 }}
          disabled={busy}
          aria-label={`Remove the print of ${r.startedAt?.slice(0, 10) ?? 'unknown date'}`}
          title="Remove this run. Its material goes back on the shelf."
          onClick={() => {
            setRemoving((x) => !x)
            setUndoCopies(true)
          }}
        >
          remove
        </button>
      </span>
      {r.failureReason && <div className="histnote">{r.failureReason}</div>}
      {note && <div className="histnote">{note}</div>}
      {removing && (
        <div className="attn crit" role="alertdialog" aria-label="Remove this print" style={{ marginTop: 6, width: '100%' }}>
          <div>
            <b>Remove this print?</b> Its {r.unitsUsed ?? 0}
            {r.unit ?? 'g'} go back on the shelf and its {fmtHours(r.hours ?? 0)} come off the project.
          </div>
          {n > 0 && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 6, fontSize: 12 }}>
              <input type="checkbox" checked={undoCopies} onChange={(e) => setUndoCopies(e.target.checked)} />
              <span>
                It marked {n} cop{n === 1 ? 'y' : 'ies'} {r.outcome === 'success' ? 'printed' : 'failed'} on the
                build sheet — {marked.map((m) => `${m.label} ${m.copies.map((c) => `#${c}`).join(', ')}`).join('; ')}.
                Set {n === 1 ? 'it' : 'them'} back to not printed.
              </span>
            </label>
          )}
          <div className="btnrow" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn sm danger"
              disabled={busy}
              onClick={() =>
                void onRemove(n > 0 && undoCopies).then(() => setRemoving(false))
              }
            >
              Remove it
            </button>
            <button type="button" className="btn sm" onClick={() => setRemoving(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function runMarks(parts: PartRow[], runId: string): { label: string; copies: number[] }[] {
  const out: { label: string; copies: number[] }[] = []
  for (const p of parts) {
    const states = statesOf(p)
    const copies = new Set<number>()
    for (const h of p.history)
      if (h.runId === runId && h.kind === 'status' && h.toStatus)
        for (const c of h.copies ?? []) if (states[c - 1] === h.toStatus) copies.add(c)
    if (copies.size) out.push({ label: p.label, copies: [...copies].sort((a, b) => a - b) })
  }
  return out
}

/**
 * A print that stopped part way, costed from where it actually got to (CG,
 * 13 Oct: a 16h 26m Maui plate stopped at 15 hours, after ghost printing).
 *
 * Two times, because they are two facts. How long the MACHINE ran is its
 * hours. When FILAMENT stopped coming out -- a clog, a tangle, a run-out --
 * is what left the spool: the printer kept moving after that and pushed
 * nothing. Grams are read from the file's own moves at that time (lib/
 * gcodeWalk.ts), not prorated: five hours into the Maui plate is 190 g by
 * the file and 108 g by a straight line. Everything stays editable -- a
 * weighed figure beats both.
 */
/** What StoppedPrint needs of a plate -- a saved import, or a file being
 *  imported right now (id null: nothing to read back or save to). */
type StopSource = Pick<SliceImportRow, 'fileName' | 'estMinutes' | 'estGrams' | 'progress' | 'keptBytes'> & {
  id: string | null
}

function StoppedPrint({
  ctx,
  slice,
  unit,
  onApply,
}: {
  ctx: ShopContext
  slice: StopSource
  unit: string
  onApply: (hours: number, units: number, note: string) => void
}) {
  // Hours, typed as hours and minutes (CG, 14 Oct).
  const [ran, setRan] = useState<number | null>(null)
  /**
   * What the failed print WEIGHS (CG, 20 Oct: "how much does the failed
   * print weigh to input, not at what point the filament stopped"). A scale
   * knows what a ghost print or a clog really left; the file only knows
   * what the printer pushed. Plus the purge and skirt that went down
   * outside the print -- weighing the part misses those.
   */
  const [weighed, setWeighed] = useState('')
  const [waste, setWaste] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressPoint[] | null>(slice.progress)
  const [reading, setReading] = useState(false)
  const [readOnce, setReadOnce] = useState(false)
  const [readErr, setReadErr] = useState<string | null>(null)
  // Read before Guma separated purge from the print: worth reading again.
  const noWaste = !!progress?.length && progress.every((p) => p.waste == null)

  /** A kept file imported before Guma read the moves: read them now, once. */
  async function readMoves() {
    setReading(true)
    setReadErr(null)
    try {
      if (!slice.id) throw new Error('That file was not kept.')
      const row = await sliceFileContent(ctx.shop.id, slice.id)
      if (!row) throw new Error('That file was not kept.')
      const bytes = await unpackFile(row.content)
      const parsed = await parseSliceFile(new File([bytes as unknown as BlobPart], slice.fileName))
      if (!parsed.progress) throw new Error('No progress marks in this file — the weight and the hours are enough.')
      await setSliceProgress(ctx.shop.id, slice.id, parsed.progress)
      setProgress(parsed.progress)
    } catch (e) {
      setReadErr(e instanceof Error ? e.message : String(e))
    } finally {
      setReading(false)
      setReadOnce(true)
    }
  }

  const total = slice.estMinutes
  const toMin = (h: number | null) => (h == null || h <= 0 ? null : Math.round(h * 60))
  const ranMin = toMin(ran)
  const at = progress && ranMin != null ? progressAt(progress, ranMin, slice.estGrams) : null
  const layerTop = progress?.length ? progress[progress.length - 1].z : null
  // The file's own purge-and-skirt by then, as the starting figure; a typed
  // one wins.
  const fileWaste = at?.waste != null ? Math.round(at.waste * 10) / 10 : null
  const num = (t: string) => {
    const v = Number(t.trim())
    return t.trim() && Number.isFinite(v) && v >= 0 ? v : null
  }
  const wasteG = waste != null ? num(waste) : fileWaste
  const weighedG = num(weighed)
  // What comes off the shelf: the weighed print plus the waste; unweighed,
  // what the file says the printer pushed by then.
  const charge = weighedG != null ? weighedG + (wasteG ?? 0) : at ? at.grams : null

  function apply(r: number | null, w: string, ws: string | null) {
    const rm = toMin(r)
    if (rm == null) return
    const a = progress ? progressAt(progress, rm, slice.estGrams) : null
    const fw = a?.waste != null ? Math.round(a.waste * 10) / 10 : null
    const wg = num(w)
    const xg = ws != null ? num(ws) : fw
    const g = wg != null ? wg + (xg ?? 0) : a ? a.grams : null
    if (g == null) return
    const note =
      `From ${slice.fileName} — stopped at ${fmtMinutes(rm)}` +
      (total ? ` of ${fmtMinutes(total)}` : '') +
      (a ? ` (${a.pct}%, layer ${a.z.toFixed(2)} mm)` : '') +
      (wg != null
        ? `; weighed ${trimG(wg)} ${unit}${xg ? ` + ${trimG(xg)} ${unit} purge and skirt` : ''}`
        : '; not weighed — the file’s figure for what the printer pushed') +
      '.'
    // Two decimals is 36 seconds: 15h 20m is stored 15.33 and reads back 15h 20m.
    onApply(Math.round((rm / 60) * 100) / 100, Math.round(g), note)
  }

  return (
    <div className="stoppedprint" role="group" aria-label="Where the print stopped">
      <div className="grid3" style={{ marginTop: 0 }}>
        <div className="fld" style={{ margin: 0 }}>
          <label className="lbl" htmlFor={`sp-ran-${slice.id}`}>
            Machine ran for{total ? ` (of ${fmtMinutes(total)})` : ''}
          </label>
          <HoursInput
            id={`sp-ran-${slice.id}`}
            label="Machine ran for"
            value={ran}
            onChange={(h) => {
              setRan(h)
              apply(h, weighed, waste)
            }}
          />
        </div>
        <div className="fld" style={{ margin: 0 }}>
          <label className="lbl" htmlFor={`sp-weight-${slice.id}`}>
            The failed print weighs ({unit})
          </label>
          <input
            id={`sp-weight-${slice.id}`}
            inputMode="decimal"
            value={weighed}
            placeholder="on the scale"
            onChange={(e) => {
              setWeighed(e.target.value)
              apply(ran, e.target.value, waste)
            }}
          />
        </div>
        <div className="fld" style={{ margin: 0 }}>
          <label className="lbl" htmlFor={`sp-waste-${slice.id}`}>
            Plus purge and skirt ({unit})
          </label>
          <input
            id={`sp-waste-${slice.id}`}
            inputMode="decimal"
            value={waste ?? (fileWaste != null ? String(fileWaste) : '')}
            placeholder={progress ? 'from the file' : 'if you know it'}
            onChange={(e) => {
              setWaste(e.target.value)
              apply(ran, weighed, e.target.value)
            }}
          />
        </div>
      </div>
      {ranMin != null && (
        <div className="hint" data-testid="stopped-at" style={{ marginTop: 6 }}>
          {at ? (
            <>
              By {fmtMinutes(ranMin)} the plate was <b>{at.pct}%</b> through, at layer {at.z.toFixed(2)}
              {layerTop ? ` of ${layerTop.toFixed(2)}` : ''} mm; the printer had pushed {Math.round(at.grams)} {unit}
              {fileWaste != null ? `, ${trimG(fileWaste)} ${unit} of it purge and skirt` : ''}.{' '}
            </>
          ) : null}
          {weighedG != null ? (
            <>
              Charged: <b>{trimG(charge ?? 0)} {unit}</b> — the {trimG(weighedG)} {unit} it weighs
              {wasteG ? ` plus ${trimG(wasteG)} ${unit} purge and skirt` : ''}
              {at && at.grams - (charge ?? 0) > 1
                ? `. The other ${Math.round(at.grams - (charge ?? 0))} ${unit} the file expected never came out — a clog or ghost printing`
                : ''}
              .
            </>
          ) : at ? (
            <>Weigh it if you can — until then the file&rsquo;s {Math.round(at.grams)} {unit} is charged, which overstates a ghost print.</>
          ) : (
            <>Put in what it weighs.</>
          )}
        </div>
      )}
      {(!progress || noWaste) && !readOnce && slice.id != null && slice.keptBytes != null && (
        <div className="btnrow" style={{ margin: '6px 0 0', alignItems: 'center' }}>
          <button type="button" className="btn sm" disabled={reading} onClick={() => void readMoves()}>
            {reading ? 'Reading the moves…' : progress ? 'Read the file for the purge' : 'Read the file to see where it stopped'}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            Optional — {progress ? 'imported before Guma separated purge and skirt from the print' : 'shows how far it got and the purge; imported before Guma read the moves'}. A few seconds, once.
          </span>
        </div>
      )}
      {readErr && (
        <div className="hint" role="alert" style={{ color: 'var(--red)', marginTop: 4 }}>
          {readErr}
        </div>
      )}
    </div>
  )
}

/** Grams to one decimal, without a trailing ".0". */
const trimG = (g: number) => String(Math.round(g * 10) / 10)

/** What the price and the spool hold become with a different build sheet. */
export interface WhatIf {
  price: { quoted: number; sheet: number; changed: boolean; quotedCopies: number; sheetCopies: number } | null
  release: ReturnType<typeof trimHolds>
}

/**
 * The build sheet priced at the quote's own frozen rates -- the same two
 * figures Estimated build shows: as quoted, and with the sheet's copies.
 * Null without a priced quote (the shop's own work has none).
 */
function sheetPriceOf(
  detail: ProjectDetail,
  pctx: Parameters<typeof priceProjectQuote>[1],
): WhatIf['price'] {
  const q = detail.quoteInputs
  if (!q) return null
  const asQuoted = priceProjectQuote(detail, pctx)
  if (!asQuoted) return null
  const sheet = sheetVsQuote(q.builds ?? [], q.quantity, detail.parts)
  const asBuilt = sheet.changed
    ? (priceProjectQuote(detail, pctx, { builds: sheet.builds, quantity: sheet.quantity }) ?? asQuoted)
    : asQuoted
  return {
    quoted: asQuoted.priced.total,
    sheet: asBuilt.priced.total,
    changed: sheet.changed,
    quotedCopies: sheet.quotedCopies,
    sheetCopies: sheet.sheetCopies,
  }
}

/** What one part's new count does to it, in a few words. */
function copiesChangeWords(p: PartRow, n: number): string {
  if (p.qty === n) return `already ${n}`
  const r = changeCopies(statesOf(p), p.spareN, n)
  const bits: string[] = []
  const k = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`
  if (r.dropped.pending) bits.push(`${k(r.dropped.pending, 'unprinted copy', 'unprinted copies')} dropped`)
  if (r.dropped.reprint) bits.push(`${k(r.dropped.reprint, 'failed copy', 'failed copies')} not reprinted`)
  if (r.toSpare) bits.push(`${k(r.toSpare, 'printed copy', 'printed copies')} kept as spare${r.toSpare === 1 ? '' : 's'}`)
  if (r.fromSpare) bits.push(`${k(r.fromSpare, 'spare', 'spares')} counted again`)
  const added = n - p.qty - r.fromSpare
  if (added > 0) bits.push(`${k(added, 'copy', 'copies')} to print`)
  return bits.join(' · ')
}

/**
 * Ticked parts to one copy count (CG, 12 Oct). Nothing is written until
 * Save, and before it the bar says what will happen: to each part (which
 * copies go, which printed ones are kept as spares), to the price against
 * what the client agreed, and to the material set aside on the spool.
 */
function CopiesBar({
  parts,
  picked,
  setTo,
  onSetTo,
  why,
  onWhy,
  whyNeeded,
  whatIf,
  money,
  busy,
  onClear,
  onSave,
}: {
  parts: PartRow[]
  picked: Set<string>
  setTo: string
  onSetTo: (v: string) => void
  why: string
  onWhy: (v: string) => void
  whyNeeded: boolean
  whatIf?: (parts: PartRow[]) => WhatIf
  money: (n: number) => string
  busy: boolean
  onClear: () => void
  onSave: (changes: { partId: string; qty: number }[], release: WhatIf['release']) => Promise<void>
}) {
  const chosen = parts.filter((p) => picked.has(p.id))
  const n = Math.floor(Number(setTo))
  const valid = setTo.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 9999
  const changing = valid ? chosen.filter((p) => p.qty !== n) : []
  const now = whatIf?.(parts) ?? null
  const next = valid && whatIf ? whatIf(parts.map((p) => (picked.has(p.id) ? { ...p, qty: n } : p))) : null
  const price = next?.price
  const priceMoves = !!price && !!now?.price && Math.abs(price.sheet - now.price.sheet) >= 0.005
  return (
    <div className="copiesbar" role="region" aria-label="Set copies on the picked parts">
      <div className="copiesbarhead">
        <b>
          {chosen.length} part{chosen.length === 1 ? '' : 's'} picked
        </b>
        <label className="lbl" htmlFor="set-copies-to" style={{ margin: 0 }}>
          Set copies to
        </label>
        <input
          id="set-copies-to"
          type="number"
          min={1}
          value={setTo}
          autoFocus
          style={{ width: 64 }}
          onChange={(e) => onSetTo(e.target.value)}
        />
        <button type="button" className="linkbtn" style={{ width: 'auto', marginLeft: 'auto' }} onClick={onClear}>
          clear
        </button>
      </div>
      {valid && (
        <>
          <ul className="copieslist">
            {chosen.map((p) => (
              <li key={p.id} className={p.qty === n ? 'same' : ''}>
                <span className="pn">{p.label}</span>
                <span className="mono">
                  {p.qty} → {n}
                </span>
                <span className="pmeta">{copiesChangeWords(p, n)}</span>
              </li>
            ))}
          </ul>
          {price && priceMoves && (
            <div className="hint" style={{ marginTop: 6 }}>
              The build sheet will price at <b>{money(price.sheet)}</b> against {money(price.quoted)} agreed (
              {price.sheet < price.quoted ? '−' : '+'}
              {money(Math.abs(price.sheet - price.quoted))}). The agreed price stays until you revise the quote —
              the link appears under the build sheet.
            </div>
          )}
          {next?.release && (
            <div className="hint" style={{ marginTop: 4 }}>
              {next.release.released.map((r) => `${r.units.toLocaleString()}${r.unit} ${r.name}`).join(', ')} set aside for
              this project goes back on the shelf.
            </div>
          )}
          <div className="btnrow" style={{ marginTop: 8, alignItems: 'flex-end' }}>
            <div className="fld" style={{ margin: 0, flex: 1, minWidth: 200, maxWidth: 420 }}>
              <label className="lbl" htmlFor="set-copies-why">
                Why{whyNeeded ? '' : ' (optional)'}
              </label>
              <input
                id="set-copies-why"
                value={why}
                placeholder="The club only needs four of each"
                onChange={(e) => onWhy(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || changing.length === 0 || (whyNeeded && !why.trim())}
              onClick={() =>
                void onSave(
                  changing.map((p) => ({ partId: p.id, qty: n })),
                  next?.release ?? null,
                )
              }
            >
              {changing.length === 0
                ? 'Nothing to change'
                : `Set ${changing.length} part${changing.length === 1 ? '' : 's'} to ${n}`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** "How many?" in place of the row's buttons -- a number, an "all", Save. */
function CountPicker({
  label,
  id,
  value,
  max,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  label: string
  id: string
  value: number
  max: number
  onChange: (n: number) => void
  onSave: () => void
  onCancel: () => void
  busy: boolean
}) {
  return (
    <div className="partacts">
      <label className="lbl" htmlFor={id} style={{ margin: 0 }}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={1}
        max={max}
        value={value}
        style={{ width: 56 }}
        onChange={(e) => onChange(Math.min(max, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
      />
      <span className="pmeta" style={{ margin: 0 }}>
        of {max}
      </span>
      {value !== max && (
        <button type="button" className="linkbtn" onClick={() => onChange(max)}>
          all
        </button>
      )}
      <button type="button" className="btn sm primary" disabled={busy || value < 1 || value > max} onClick={onSave}>
        Save
      </button>
      <button type="button" className="btn sm ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}
