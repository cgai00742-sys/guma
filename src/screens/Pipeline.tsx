/**
 * Pipeline board. Ported from design-package/design/Pipeline Board.dc.html —
 * same seven columns, same drag-and-drop, same card anatomy — wired to real
 * projects instead of the mockup's SEED array.
 *
 * THE SIGNAL STRIP, and why its three slots mean something different here.
 *
 * guma.css's own comment on .proj .flag is emphatic: the strip is three
 * FIXED slots, position is meaning, and a slot is never omitted because a
 * dark slot is data too. The design named those slots STEWARD · RISK ·
 * WINDOW. Guma has no steward assignment — jobs.steward_id exists as a
 * column but nothing writes it — so slot 1 would be dark on every card
 * forever, which is not "no signal", it is a fabricated uniform one.
 *
 * So the slots are kept, in the same order, in the same shapes, and
 * redefined to the three things this app genuinely knows:
 *
 *   slot 1  MONEY   (red)   unpaid deposit, unpaid balance, or no quote at
 *                           all. The design's reasoning for red on slot 1
 *                           was "unowned work is blocked work"; unsecured
 *                           work is the same sentence with a different
 *                           subject.
 *   slot 2  TIME    (warn)  overdue, or stalled with no update in a
 *                           fortnight.
 *   slot 3  PROMISE (info)  the delivery window is at risk, or the price
 *                           is under the shop's own minimum.
 *
 * Every one of those is computed by src/lib/gates.ts from a fact already
 * on the row. The card's left edge takes the worst lit slot's colour via
 * data-sev, exactly as the design intended, so the board reads by pattern
 * at column scale without anybody reading a word.
 *
 * Progress % is still left out: jobs.progress_pct defaults to 0 and
 * nothing moves it, so a bar would read "stalled at 0%" on every card
 * forever. The gate counter took its place in the footer — that number is
 * real, and it is a better answer to "how far along is this" anyway.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  JOB_PHASES,
  listJobs,
  updateJobPhase,
  updateJobPriority,
  type JobListRow,
  type JobPhase,
  type JobPriority,
  type ShopContext,
} from '../lib/data'
import { PHASE_LABEL, flagsFor, gateStatus, worstTone, type Flag } from '../lib/gates'

const COLUMN_HUE: Record<JobPhase, string> = {
  intake: 'var(--gray)',
  design: 'var(--info)',
  approval: 'var(--violet)',
  scheduled: 'var(--teal)',
  building: 'var(--ember)',
  review: 'var(--warn)',
  delivered: 'var(--ok)',
}

const PRIORITY_ORDER: JobPriority[] = ['low', 'medium', 'high', 'urgent']
const nextPriority = (p: JobPriority): JobPriority =>
  PRIORITY_ORDER[(PRIORITY_ORDER.indexOf(p) + 1) % PRIORITY_ORDER.length]

/** The three fixed slots, in order. See the block comment above. */
const SLOTS = [
  { cls: 'f-steward', keys: ['deposit', 'balance', 'unquoted', 'unagreed'], name: 'Money' },
  { cls: 'f-risk', keys: ['overdue', 'stalled'], name: 'Time' },
  { cls: 'f-window', keys: ['window', 'under-minimum'], name: 'Promise' },
] as const

interface Decorated extends JobListRow {
  flags: Flag[]
  gateDone: number
  gateTotal: number
}

export default function Pipeline({ ctx, viewSwitch }: { ctx: ShopContext; viewSwitch?: React.ReactNode }) {
  const navigate = useNavigate()
  const [jobs, setJobs] = useState<JobListRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overPhase, setOverPhase] = useState<JobPhase | null>(null)
  const [query, setQuery] = useState('')
  const [flaggedOnly, setFlaggedOnly] = useState(false)

  useEffect(() => {
    let cancelled = false
    listJobs(ctx.shop.id)
      .then((rows) => {
        if (!cancelled) setJobs(rows)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [ctx.shop.id])

  /** Flags and gate progress, computed once per row per render rather than
   *  inside the card, so the stat tiles and the columns agree by
   *  construction instead of by two copies of the same call. */
  // Drafts are deliberately absent. A board that fills up with prices
  // nobody has agreed to stops being a board -- see 0008_drafts.sql. They
  // are one click away in the list, and the count below says how many.
  const drafts = useMemo(() => (jobs ?? []).filter((j) => !j.facts.takenInAt).length, [jobs])

  const decorated: Decorated[] = useMemo(
    () =>
      (jobs ?? [])
        .filter((j) => j.facts.takenInAt)
        .map((j) => {
          const gate = gateStatus(j.phase, j.gateAnswers, j.facts)
          return { ...j, flags: flagsFor(j.facts), gateDone: gate.done, gateTotal: gate.total }
        }),
    [jobs],
  )

  const stats = useMemo(() => {
    const active = decorated.filter((j) => j.phase !== 'delivered')
    return {
      active: active.length,
      building: decorated.filter((j) => j.phase === 'building').length,
      flagged: active.filter((j) => j.flags.length > 0).length,
      overdue: active.filter((j) => j.flags.some((f) => f.key === 'overdue')).length,
      unpaid: decorated.filter((j) => j.facts.depositOwed > 0 || j.facts.balanceOwed > 0).length,
    }
  }, [decorated])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return decorated.filter((j) => {
      if (flaggedOnly && j.flags.length === 0) return false
      if (!q) return true
      return (
        j.title.toLowerCase().includes(q) ||
        j.clientName.toLowerCase().includes(q) ||
        j.ref.toLowerCase().includes(q)
      )
    })
  }, [decorated, query, flaggedOnly])

  const columns = useMemo(
    () =>
      JOB_PHASES.map((phase) => ({
        phase,
        label: PHASE_LABEL[phase],
        hue: COLUMN_HUE[phase],
        jobs: filtered.filter((j) => j.phase === phase),
      })),
    [filtered],
  )

  async function move(jobId: string, toPhase: JobPhase) {
    setDragId(null)
    setOverPhase(null)
    const prior = jobs
    if (!prior) return
    const job = prior.find((j) => j.jobId === jobId)
    if (!job || job.phase === toPhase) return
    // Optimistic, same as the mockup's instant local setState — a real
    // write happens underneath, and reverts the board if it fails.
    //
    // Dragging deliberately does NOT enforce the gate. The gate is advice
    // with teeth on the project page, where the reason it is blocked can
    // actually be read; a board that silently refuses a drop just looks
    // broken. The card keeps showing what is outstanding either way.
    setJobs(prior.map((j) => (j.jobId === jobId ? { ...j, phase: toPhase } : j)))
    try {
      await updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, toPhase)
      setJobs(await listJobs(ctx.shop.id))
    } catch (e) {
      setJobs(prior)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function cyclePriority(job: JobListRow) {
    const prior = jobs
    if (!prior) return
    const next = nextPriority(job.priority)
    setJobs(prior.map((j) => (j.jobId === job.jobId ? { ...j, priority: next } : j)))
    try {
      await updateJobPriority(ctx.shop.id, job.jobId, next)
    } catch (e) {
      setJobs(prior)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    // guma.css's own body:has(.board)/.wrap:has(.board) rules give this
    // page its whole flex/height chain automatically (see that comment
    // block in guma.css) — no manual layout needed here.
    <div className="wrap" style={{ paddingTop: 16, paddingBottom: 20 }}>
      <div className="section-head">
        <div>
          <h2>Projects</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            {jobs ? 'Drag a card between columns · click a name to open it' : 'Loading…'}
          </div>
        </div>
        {viewSwitch}
        <Link to="/intake" className="btn primary" style={{ textDecoration: 'none' }}>
          New project
        </Link>
      </div>

      {error && (
        <div className="alert" style={{ marginBottom: 8 }}>
          <span>{error}</span>
        </div>
      )}

      <div className="kpis" style={{ margin: '0 0 12px' }}>
        <Kpi label="Active" value={stats.active} />
        <Kpi label="In build" value={stats.building} />
        <Kpi
          label="Flagged"
          value={stats.flagged}
          tone={stats.flagged > 0 ? 'warn' : 'good'}
          onClick={() => setFlaggedOnly((v) => !v)}
          pressed={flaggedOnly}
        />
        <Kpi label="Overdue" value={stats.overdue} tone={stats.overdue > 0 ? 'alert' : 'good'} />
        <Kpi label="With money owed" value={stats.unpaid} tone={stats.unpaid > 0 ? 'alert' : 'good'} />
      </div>

      <div className="filters" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <input
          value={query}
          placeholder="Search project, client or reference"
          style={{ maxWidth: 300 }}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(query || flaggedOnly) && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setQuery('')
              setFlaggedOnly(false)
            }}
          >
            Clear
          </button>
        )}
        <span className="hint" style={{ marginTop: 0 }}>
          {filtered.length} of {decorated.length} shown
          {flaggedOnly ? ' · flagged only' : ''}
        </span>
        {drafts > 0 && (
          <Link
            to="/projects?view=list&show=drafts"
            className="chip"
            style={{ textDecoration: 'none', marginLeft: 'auto' }}
            title="Saved prices that have not been taken in. They are not on the board on purpose."
          >
            {drafts} draft{drafts === 1 ? '' : 's'} →
          </Link>
        )}
      </div>

      <div className="board">
        {columns.map((col) => (
          <section
            key={col.phase}
            className={overPhase === col.phase ? 'col drag-over' : 'col'}
            onDragOver={(e) => {
              e.preventDefault()
              if (overPhase !== col.phase) setOverPhase(col.phase)
            }}
            onDragLeave={(e) => {
              const related = e.relatedTarget instanceof Node ? e.relatedTarget : null
              if (!(related && e.currentTarget.contains(related)) && overPhase === col.phase) {
                setOverPhase(null)
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId) void move(dragId, col.phase)
            }}
          >
            <h3>
              <i className="dot" style={{ background: col.hue }} />
              {col.label}
              <span className="count">{col.jobs.length}</span>
            </h3>
            <div className="stack">
              {col.jobs.map((job) => (
                <Card
                  key={job.jobId}
                  job={job}
                  dragging={dragId === job.jobId}
                  onOpen={() => navigate(`/project/${job.jobId}`)}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', job.jobId)
                    setDragId(job.jobId)
                  }}
                  onDragEnd={() => {
                    setDragId(null)
                    setOverPhase(null)
                  }}
                  onCyclePriority={() => void cyclePriority(job)}
                />
              ))}
              {col.jobs.length === 0 && <div className="empty">Drop a project here</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Card({
  job,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  onCyclePriority,
}: {
  job: Decorated
  dragging: boolean
  onOpen: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onCyclePriority: () => void
}) {
  const sev = worstTone(job.flags)
  const gateShort = job.gateTotal > 0 ? `gate ${job.gateDone}/${job.gateTotal}` : 'delivered'

  return (
    <article
      className={dragging ? 'proj dragging' : 'proj'}
      data-sev={sev ?? undefined}
      draggable
      tabIndex={0}
      aria-label={`${job.title}, ${job.clientName}, ${job.priority} priority, ${gateShort}${
        job.flags.length ? `, ${job.flags.length} flags` : ''
      }`}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <i className="grip" />
      <button
        type="button"
        className="pname"
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          color: 'inherit',
          width: '100%',
        }}
        onClick={onOpen}
        title="Open this project"
      >
        {job.title}
      </button>
      <div className="pmeta">
        {job.clientName} · {job.ref}
      </div>

      {/* Three fixed slots, always all three, lit or dark. See the block
          comment at the top of this file for what each one means. */}
      <div className="flag" title={job.flags.map((f) => `${f.label} — ${f.cause}`).join('\n') || 'No flags'}>
        {SLOTS.map((slot) => {
          const hit = job.flags.filter((f) => (slot.keys as readonly string[]).includes(f.key))
          return (
            <span
              key={slot.cls}
              className={`flagchip ${slot.cls} ${hit.length ? 'on' : ''}`.trim()}
              aria-label={hit.length ? `${slot.name}: ${hit.map((f) => f.label).join(', ')}` : `${slot.name}: clear`}
            />
          )
        })}
      </div>

      <div className="pfoot">
        <span className="pct" title="Gate items cleared for this stage">
          {gateShort}
        </span>
        {job.facts.neededBy && (
          <span className="pct" title="Needed by">
            · {job.facts.neededBy.slice(5)}
          </span>
        )}
        <button
          type="button"
          className={`badge p-${job.priority}`}
          style={{
            marginLeft: 'auto',
            border: 'none',
            appearance: 'none',
            font: 'inherit',
            cursor: 'pointer',
          }}
          title="Click to change priority"
          onClick={onCyclePriority}
        >
          {job.priority}
        </button>
      </div>
    </article>
  )
}

function Kpi({
  label,
  value,
  tone,
  onClick,
  pressed,
}: {
  label: string
  value: number
  tone?: 'good' | 'warn' | 'alert'
  onClick?: () => void
  pressed?: boolean
}) {
  const className = `kpi${tone ? ` ${tone}` : ''}${onClick ? ' click' : ''}`
  const body = (
    <>
      <div className="lbl">{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 20 }}>{value}</div>
    </>
  )
  if (!onClick) return <div className={className}>{body}</div>
  return (
    <button
      type="button"
      className={className}
      aria-pressed={pressed}
      style={{
        textAlign: 'left',
        font: 'inherit',
        cursor: 'pointer',
        outline: pressed ? '1px solid var(--ember)' : undefined,
      }}
      onClick={onClick}
    >
      {body}
    </button>
  )
}
