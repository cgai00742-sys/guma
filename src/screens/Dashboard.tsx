/**
 * The shop at a glance.
 *
 * Every number here is derived from something already recorded -- there is
 * no dashboard-only data and nothing is stored to make this page faster.
 * A figure that exists only on a dashboard is a figure nobody reconciles.
 *
 * Two rules it keeps, both from the rest of the program:
 *
 *   - NAME WHAT CANNOT BE MEASURED. A shop that has logged no build runs
 *     has not spent zero; it has not told Guma yet. Those read "not
 *     recorded yet" and say what to do, rather than showing $0 and
 *     implying a fact.
 *   - EVERY NUMBER GOES SOMEWHERE. A count you cannot click is a number you
 *     have to go and find again by hand, so each tile links to the screen
 *     that explains it.
 *
 * What it deliberately does NOT do: charts of things that have not happened
 * yet, week-over-week trends on a shop with four projects, or a utilisation
 * percentage computed against an invented "available hours" figure. A made
 * up denominator is worse than no metric.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { listJobs, listMaterials, listShelf } from '../lib/data'
import type { JobListRow, MaterialRow, ProductRow, ShopContext } from '../lib/data.types'
import { makeMoney } from '../lib/pricing'
import { osCurrency, osLocale } from '../lib/locale'
import { flagsFor } from '../lib/gates'
import { planFor } from '../lib/setupPlan'
import { daysBetweenLocal } from '../lib/dates'

export default function Dashboard({ ctx }: { ctx: ShopContext }) {
  const [jobs, setJobs] = useState<JobListRow[] | null>(null)
  const [materials, setMaterials] = useState<MaterialRow[] | null>(null)
  const [shelf, setShelf] = useState<ProductRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([listJobs(ctx.shop.id), listMaterials(ctx.shop.id), listShelf(ctx.shop.id)])
      .then(([j, m, s]) => {
        if (cancelled) return
        setJobs(j)
        setMaterials(m)
        setShelf(s)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [ctx.shop.id])

  // Never 'USD'/'en-US' as the fallback -- locale.test.ts fails the build
  // on a hard-coded region, because a shop in Saipan or Berlin opening a
  // dashboard denominated in dollars is the program telling it where it is
  // allowed to be.
  const { money } = useMemo(
    () => makeMoney(ctx.shop.currency || osCurrency(), ctx.shop.locale || osLocale()),
    [ctx.shop.currency, ctx.shop.locale],
  )

  const s = useMemo(() => summarize(jobs, materials, shelf, ctx), [jobs, materials, shelf, ctx])

  const setup = useMemo(
    () =>
      planFor({
        shop: ctx.shop,
        rateCard: ctx.rateCard,
        printerRows: ctx.printerRows,
        materials: ctx.materials as never,
      }),
    [ctx],
  )

  if (error)
    return (
      <div className="wrap" style={{ paddingTop: 20 }}>
        <div className="attn crit">
          <b>Could not load the dashboard.</b>
          <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11 }}>{error}</div>
        </div>
      </div>
    )

  if (!s)
    return (
      <div className="wrap" style={{ paddingTop: 20 }}>
        <div className="prload">Loading…</div>
      </div>
    )

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 48 }}>
      {/* The unfinished-setup banner follows the home screen.
          It lived on Projects because that was where people landed, and the
          whole reason deferring setup is acceptable is that the banner
          carries what is still missing. Moving home to the dashboard
          without bringing it would have made "finish later" mean "forget
          about it", which is the opposite of the intent. */}
      {!setup.done && (
        <div
          className={setup.distorting.length > 0 ? 'attn crit' : 'notice'}
          style={{ marginTop: 0, marginBottom: 14 }}
        >
          <span>
            <b>
              {setup.distorting.length > 0
                ? 'Your numbers are not right yet.'
                : `${Math.round(setup.completeness * 100)}% configured.`}
            </b>{' '}
            {setup.distorting.length > 0
              ? setup.distorting[0].cost
              : `Still to do: ${setup.remaining.map((x) => x.title.toLowerCase()).join(', ')}.`}{' '}
            <Link to="/setup-guide">
              {setup.distorting.length > 0 ? 'finish setting up' : 'carry on setting up'}
            </Link>
          </span>
        </div>
      )}

      <div className="section-head">
        <div>
          <h2>{ctx.shop.name}</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            everything below is read from what you have already recorded
          </div>
        </div>
        <Link to="/intake" className="btn primary sm" style={{ textDecoration: 'none' }}>
          + New project
        </Link>
      </div>

      {/* ---- the four at a glance ---- */}
      <div className="dtiles" style={{ marginTop: 6 }}>
        <Tile
          to="/projects"
          label="Projects open"
          hue="biolum"
          value={String(s.open)}
          sub={
            s.needsAttention > 0
              ? `${s.needsAttention} need attention`
              : s.open === 0
                ? 'nothing on the board'
                : 'all moving'
          }
          tone={s.needsAttention > 0 ? 'warn' : ''}
        />
        <Tile
          to="/projects"
          label="Cost of work delivered"
          hue="ember"
          value={s.hasActuals ? money(s.cogs) : '—'}
          sub={
            s.hasActuals
              ? `${s.deliveredCount} project${s.deliveredCount === 1 ? '' : 's'} · material, machine, wear, power, hours`
              : 'no build runs logged yet'
          }
          tone={s.hasActuals ? '' : 'muted'}
        />
        <Tile
          to="/settings?tab=machines"
          label="Printer fleet"
          hue="teal"
          value={String(s.printers)}
          sub={
            s.machineHours > 0
              ? `${round1(s.machineHours)} h logged · ${s.failRate === null ? 'no failures' : `${s.failRate}% of material lost`}`
              : 'no runs logged yet'
          }
        />
        <Tile
          to="/settings?tab=materials"
          label="Materials on hand"
          hue="violet"
          value={s.stockValue > 0 ? money(s.stockValue) : '—'}
          sub={
            s.lowStock.length > 0
              ? `${s.lowStock.length} at or below reorder`
              : s.materialCount === 0
                ? 'none set up'
                : `${s.materialCount} in stock`
          }
          tone={s.lowStock.length > 0 ? 'warn' : ''}
        />
      </div>

      <div className="grid2" style={{ marginTop: 18, gap: 14 }}>
        {/* ---- where the work is ---- */}
        <section className="sec" style={{ marginTop: 0 }}>
          <div className="sechead">
            <h4>Where the work is</h4>
            <span className="secstat">{s.open} open</span>
          </div>
          <div className="pane">
            {s.open === 0 ? (
              <div className="hint" style={{ marginTop: 0 }}>
                Nothing on the board. <Link to="/intake">Start a project</Link> — it can be your own
                work; it does not need a client.
              </div>
            ) : (
              s.byPhase.map((p) => (
                <div key={p.phase} className="fp-row" style={{ alignItems: 'center' }}>
                  <span className="lab" style={{ minWidth: 92 }}>
                    {p.label}
                  </span>
                  <span className="barwrap" style={{ flex: 1 }}>
                    <span
                      className="bar"
                      style={{ width: `${Math.round((p.n / Math.max(1, s.open)) * 100)}%` }}
                    />
                  </span>
                  <span className="dr-v" style={{ minWidth: 28, textAlign: 'right' }}>
                    {p.n}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* ---- money ---- */}
        <section className="sec" style={{ marginTop: 0 }}>
          <div className="sechead">
            <h4>Money</h4>
            <span className={`secstat ${s.owed > 0 ? 'crit' : 'ok'}`}>
              {s.owed > 0 ? `${money(s.owed)} owed` : 'nothing outstanding'}
            </span>
          </div>
          <div className="pane">
            <Row label="Quoted and accepted, not yet delivered" value={money(s.inFlight)} />
            <Row label="Deposits not received" value={money(s.depositOwed)} tone={s.depositOwed > 0 ? 'crit' : ''} />
            <Row label="Balances not received" value={money(s.balanceOwed)} tone={s.balanceOwed > 0 ? 'crit' : ''} />
            <Row label="Delivered, this shop's own work" value={`${s.inHouseDelivered} project${s.inHouseDelivered === 1 ? '' : 's'}`} />
            <div className="hint" style={{ marginTop: 8 }}>
              Owed is derived from payments, which are append-only — a refund is a row, never an
              edit. <Link to="/projects">Open the board</Link> to chase anything here.
            </div>
          </div>
        </section>
      </div>

      <div className="grid2" style={{ marginTop: 14, gap: 14 }}>
        {/* ---- needs attention ---- */}
        <section className="sec" style={{ marginTop: 0 }}>
          <div className="sechead">
            <h4>Needs attention</h4>
            <span className={`secstat ${s.attention.length > 0 ? 'warn' : 'ok'}`}>
              {s.attention.length || 'clear'}
            </span>
          </div>
          <div className="pane">
            {s.attention.length === 0 ? (
              <div className="hint" style={{ marginTop: 0 }}>
                Nothing flagged, nothing overdue. This is the state you want the board in.
              </div>
            ) : (
              s.attention.slice(0, 6).map((a) => (
                <Link
                  key={a.jobId}
                  to={`/project/${a.jobId}`}
                  className="flagrow"
                  style={{ textDecoration: 'none', display: 'flex', gap: 10, alignItems: 'flex-start' }}
                >
                  <span className={`flagtag ${a.tone}`}>{a.tag}</span>
                  <span>
                    <span className="fw">{a.title}</span>
                    <span className="fa">{a.why}</span>
                  </span>
                </Link>
              ))
            )}
            {s.attention.length > 6 && (
              <div className="hint" style={{ marginTop: 8 }}>
                <Link to="/projects">and {s.attention.length - 6} more on the board</Link>
              </div>
            )}
          </div>
        </section>

        {/* ---- stock ---- */}
        <section className="sec" style={{ marginTop: 0 }}>
          <div className="sechead">
            <h4>Stock</h4>
            <span className={`secstat ${s.lowStock.length > 0 ? 'warn' : ''}`}>
              {s.lowStock.length > 0 ? `${s.lowStock.length} low` : 'fine'}
            </span>
          </div>
          <div className="pane">
            {s.lowStock.length > 0 ? (
              s.lowStock.slice(0, 5).map((m) => (
                <Row
                  key={m.id}
                  label={m.name}
                  value={`${round1(m.onHand)} ${m.unit} left · reorder at ${round1(m.reorderAt)}`}
                  tone="warn"
                />
              ))
            ) : (
              <div className="hint" style={{ marginTop: 0 }}>
                {s.materialCount === 0 ? (
                  <>
                    No materials set up yet. <Link to="/settings?tab=materials">Add a spool</Link> —
                    until then a quote cannot cost its material honestly.
                  </>
                ) : (
                  'Nothing at or below its reorder point.'
                )}
              </div>
            )}
            <Row label="Value on hand" value={s.stockValue > 0 ? money(s.stockValue) : 'not priced yet'} />
            <Row
              label="Finished units on the shelf"
              value={s.shelfUnits > 0 ? `${s.shelfUnits} · ${money(s.shelfValue)}` : 'none'}
            />
            <div className="hint" style={{ marginTop: 8 }}>
              <Link to="/settings?tab=materials">Materials</Link> ·{' '}
              <Link to="/shelf">The Shelf</Link>
            </div>
          </div>
        </section>
      </div>

      {/* ---- fleet ---- */}
      <section className="sec">
        <div className="sechead">
          <h4>The fleet</h4>
          <span className="secstat">
            {s.printers} machine{s.printers === 1 ? '' : 's'}
          </span>
        </div>
        <div className="pane">
          {s.printers === 0 ? (
            <div className="hint" style={{ marginTop: 0 }}>
              No machines yet. <Link to="/settings?tab=machines">Add one</Link> — a quote needs an
              hourly rate and a wear rate to price print time at all.
            </div>
          ) : (
            <>
              <Row label="Machine hours logged" value={s.machineHours > 0 ? `${round1(s.machineHours)} h` : 'none yet'} />
              <Row label="Build runs recorded" value={s.runs > 0 ? String(s.runs) : 'none yet'} />
              <Row
                label="Material lost to failed prints"
                value={
                  s.materialUnits > 0
                    ? `${round1(s.failedUnits)} of ${round1(s.materialUnits)} units · ${s.failRate}%`
                    : 'not recorded yet'
                }
                tone={s.failRate !== null && s.failRate > 10 ? 'warn' : ''}
              />
              <Row label="Parts sent back to reprint" value={s.reprints > 0 ? String(s.reprints) : 'none'} tone={s.reprints > 0 ? 'warn' : ''} />
              <div className="hint" style={{ marginTop: 8 }}>
                A failure rate is worth watching against the allowance in{' '}
                <Link to="/settings?tab=costs">what it costs you</Link>: if real failures run above
                the percentage you price with, every quote is a little optimistic.
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

/* ---- pieces ------------------------------------------------------------- */

/**
 * One headline number.
 *
 * It was a `.kpi` with three <span>s inside a link -- and spans are inline,
 * so the label, the 22px number and the sentence under it ran together on
 * the same line wherever they fit. Reported as "the numbers that are bigger
 * and in bold are not visibly appealing, they are too tight." They were
 * not spaced badly; they were not stacked at all.
 *
 * Each tile now stacks, breathes, and carries its own colour, so the four
 * read as four different things at a glance rather than one grey row. The
 * hue belongs to the tile, not to the value's state: a warning goes on the
 * sentence underneath, where it can say what is wrong.
 */
function Tile({
  to,
  label,
  value,
  sub,
  hue,
  tone = '',
}: {
  to: string
  label: string
  value: string
  sub: string
  hue: 'biolum' | 'ember' | 'teal' | 'violet'
  tone?: string
}) {
  return (
    <Link to={to} className={`dtile ${hue} ${tone}`.trim()} style={{ textDecoration: 'none' }}>
      <span className="dt-lab">{label}</span>
      <span className="dt-v">{value}</span>
      <span className="dt-sub">{sub}</span>
    </Link>
  )
}

/** A labelled figure in a panel. Its own class rather than the global
 *  `.v`, which is a 22px headline style: in a list of rows it crowded the
 *  label and every row read as shouting. */
function Row({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="drow">
      <span className="dr-lab">{label}</span>
      <span className={`dr-v ${tone}`.trim()}>{value}</span>
    </div>
  )
}

const round1 = (n: number) => Math.round(n * 10) / 10

/* ---- the arithmetic ----------------------------------------------------- */

const PHASE_ORDER = [
  ['intake', 'Intake'],
  ['approval', 'Approval'],
  ['design', 'Design'],
  ['scheduled', 'Scheduled'],
  ['building', 'Building'],
  ['review', 'Review'],
] as const

function summarize(
  jobs: JobListRow[] | null,
  materials: MaterialRow[] | null,
  shelf: ProductRow[] | null,
  ctx: ShopContext,
) {
  if (!jobs || !materials || !shelf) return null

  const live = jobs.filter((j) => j.facts.takenInAt && j.facts.phase !== 'delivered')
  const delivered = jobs.filter((j) => j.facts.phase === 'delivered')

  // COGS is the cost of work that actually left the shop. Work in progress
  // has consumed material too, but it is not a cost of anything sold yet.
  const withActuals = delivered.filter((j) => j.facts.hasActuals)
  const cogs = withActuals.reduce((t, j) => t + j.facts.actualCost, 0)

  const materialUnits = jobs.reduce((t, j) => t + j.facts.materialUnits, 0)
  const failedUnits = jobs.reduce((t, j) => t + j.facts.failedUnits, 0)
  const machineHours = jobs.reduce((t, j) => t + j.facts.machineHours, 0)
  const runs = jobs.reduce((t, j) => t + j.facts.actualRuns, 0)
  const reprints = jobs.reduce((t, j) => t + j.facts.reprintsEver, 0)

  const attention: { jobId: string; title: string; tag: string; why: string; tone: string }[] = []
  for (const j of live) {
    const flags = flagsFor(j.facts)
    if (flags.length)
      attention.push({
        jobId: j.jobId,
        title: j.title,
        tag: flags[0].label,
        why: flags[0].cause,
        tone: flags[0].tone,
      })
    else if (j.facts.neededBy && daysBetweenLocal(j.facts.neededBy, new Date()) < 0)
      attention.push({
        jobId: j.jobId,
        title: j.title,
        tag: 'Overdue',
        why: `was due ${j.facts.neededBy}`,
        tone: 'crit',
      })
  }

  const liveMaterials = materials.filter((m) => !m.archived)
  const lowStock = liveMaterials.filter((m) => m.reorderAt > 0 && m.onHand <= m.reorderAt)
  const stockValue = liveMaterials.reduce((t, m) => t + m.onHand * (m.avgCostPerUnit ?? m.costPerUnit), 0)

  // Units still on the shelf, and what they cost to make -- NOT what they
  // might sell for. Valuing unsold stock at its hoped-for price is how a
  // shop talks itself into thinking it has money it has not earned.
  const batches = shelf.flatMap((p) => p.batches)
  const shelfUnits = batches.reduce((t, b) => t + b.units_left, 0)
  const shelfValue = batches.reduce((t, b) => t + b.units_left * b.unit_cost, 0)

  return {
    open: live.length,
    deliveredCount: withActuals.length,
    inHouseDelivered: delivered.filter((j) => j.facts.kind === 'inhouse').length,
    needsAttention: attention.length,
    attention,
    byPhase: PHASE_ORDER.map(([phase, label]) => ({
      phase,
      label,
      n: live.filter((j) => j.facts.phase === phase).length,
    })).filter((p) => p.n > 0 || live.length === 0),
    cogs,
    hasActuals: withActuals.length > 0,
    inFlight: live.reduce((t, j) => t + (j.facts.quoteStatus === 'accepted' ? (j.facts.quoteTotal ?? 0) : 0), 0),
    depositOwed: jobs.reduce((t, j) => t + j.facts.depositOwed, 0),
    balanceOwed: jobs.reduce((t, j) => t + j.facts.balanceOwed, 0),
    get owed() {
      return this.depositOwed + this.balanceOwed
    },
    printers: ctx.printerRows.filter((p) => !p.archived).length,
    machineHours,
    runs,
    reprints,
    materialUnits,
    failedUnits,
    // Null, not zero: a shop with no runs has not achieved a 0% failure
    // rate, it has not measured one.
    failRate: materialUnits > 0 ? Math.round((failedUnits / materialUnits) * 1000) / 10 : null,
    materialCount: liveMaterials.length,
    lowStock,
    stockValue,
    shelfUnits,
    shelfValue,
  }
}
