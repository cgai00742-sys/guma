/**
 * Prints to check — every print the printer logged, waiting for a person to
 * say how it came off and where it belongs (CG, 24 Nov 2026).
 *
 * The first Prusa Connect sync wrote straight onto RS850: how each print
 * came off, which project, which assembly the pieces went into. A day later
 * CG found a plate had failed on quality, and Guma would not let him say so
 * (its pieces were already placed), nor tie it to the reprint that had
 * already been recorded.
 *
 * So prints wait here first. What the printer said is shown as fact; what
 * Guma guesses (the project) is offered beside the field, never filled in;
 * how it came off is always the person's call. Approving puts prints on
 * their projects OLDEST FIRST, so a failure queues its reprint before the
 * reprint arrives and the two are linked without anyone linking them.
 *
 * It lives at the top of Projects, not on a page of its own (CG, 25 Nov:
 * "what a user needs to check off when entering the Projects tab ... less
 * is more"), and shows nothing at all when nothing is waiting.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import * as data from '../lib/data'
import { listInbox, decideInbox, setInboxStatus, listJobs, listAssemblies } from '../lib/data'
import type { AssemblyRow, InboxDecision, InboxRow, JobListRow, ShopContext } from '../lib/data.types'
import { approveInbox, notReady, objectCalls } from '../lib/printInbox'
import { Flash, useFlash } from './Saving'

const REASONS = ['Quality', 'Adhesion', 'Warping', 'Layer shift', 'Spaghetti', 'Stringing', 'Cancelled', 'Test print']
/** Shown before "show the rest": the oldest few, since they go first. */
const FIRST = 4

function when(iso: string | null): string {
  if (!iso) return 'date unknown'
  const day = iso.slice(0, 10)
  const time = /T(\d\d:\d\d)/.exec(iso)?.[1]
  return time ? `${day} ${time}` : day
}

function hm(min: number | null): string {
  if (min == null) return '—'
  const h = Math.floor(min / 60)
  const m = Math.round(min - h * 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

/** How many prints are waiting -- for the Dashboard and a project page. A
 *  missing or failing read counts as none rather than breaking the page. */
export function useWaitingPrints(ctx: ShopContext | null, deps: unknown[] = []): InboxRow[] {
  const [rows, setRows] = useState<InboxRow[]>([])
  useEffect(() => {
    if (!ctx) return
    let live = true
    Promise.resolve()
      .then(() => listInbox(ctx.shop.id, 'new'))
      .then(
        (r) => live && setRows(Array.isArray(r) ? r : []),
        () => {},
      )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.shop.id, ...deps])
  return rows
}

export function PrintsToCheck({ ctx }: { ctx: ShopContext }) {
  const [search, setSearch] = useSearchParams()
  const only = search.get('prints')
  const [rows, setRows] = useState<InboxRow[] | null>(null)
  const [jobs, setJobs] = useState<JobListRow[]>([])
  const [assemblies, setAssemblies] = useState<Record<string, AssemblyRow[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [flash, say] = useFlash()

  const reload = useCallback(async () => {
    const [r, j] = await Promise.all([listInbox(ctx.shop.id, 'new'), listJobs(ctx.shop.id)])
    setRows(Array.isArray(r) ? r : [])
    setJobs(j.filter((x) => x.phase !== 'delivered'))
  }, [ctx.shop.id])
  useEffect(() => {
    // Read safely: a shop whose data layer has no Inbox shows no section.
    Promise.resolve()
      .then(reload)
      .catch(() => setRows([]))
  }, [reload])

  // The assemblies of every project a waiting print points at.
  useEffect(() => {
    if (!rows) return
    const want = [...new Set(rows.map((r) => r.decision.jobId).filter((x): x is string => !!x))].filter((id) => !(id in assemblies))
    if (!want.length) return
    void Promise.all(want.map(async (id) => [id, await listAssemblies(ctx.shop.id, id)] as const)).then((pairs) =>
      setAssemblies((a) => ({ ...a, ...Object.fromEntries(pairs) })),
    )
  }, [rows, assemblies, ctx.shop.id])

  const shown = useMemo(() => (rows ?? []).filter((r) => !only || r.decision.jobId === only || r.suggestedJobId === only), [rows, only])
  const ready = shown.filter((r) => !notReady(r))
  const guessable = shown.filter((r) => !r.decision.jobId && r.suggestedJobId && jobs.some((j) => j.jobId === r.suggestedJobId))
  const jobName = (id: string | null | undefined) => {
    const j = jobs.find((x) => x.jobId === id)
    return j ? `${j.ref} · ${j.title}` : null
  }

  async function decide(row: InboxRow, patch: Partial<InboxDecision>) {
    const next = { ...row.decision, ...patch }
    // A new project means a new set of assemblies; the old choice is gone.
    if ('jobId' in patch && patch.jobId !== row.decision.jobId) next.assemblyId = null
    setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...r, decision: next } : r)) ?? null)
    try {
      await decideInbox(ctx.shop.id, row.id, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await reload()
    }
  }

  async function approve(ids: string[]) {
    setBusy(true)
    setError(null)
    try {
      const res = await approveInbox(ctx, data, ids)
      const bad = res.find((r) => !r.ok)
      const good = res.filter((r) => r.ok).length
      if (good) say(`${good} print${good === 1 ? '' : 's'} put on ${good === 1 ? 'its project' : 'their projects'}.`)
      if (bad) setError(`Stopped at ${bad.said} The prints after it are still waiting — they may be its reprints.`)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function setAside(row: InboxRow) {
    setBusy(true)
    try {
      await setInboxStatus(ctx.shop.id, row.id, 'ignored')
      say(`${row.fileName} set aside — not counted on any project.`)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  // Nothing waiting: no section at all. The flash still shows what just
  // happened, so approving the last print is not met with silence.
  if (!rows || (shown.length === 0 && !only)) return flash ? <div className="wrap" style={{ paddingTop: 12 }}><Flash message={flash} /></div> : null
  const list = all ? shown : shown.slice(0, FIRST)

  return (
    <div className="wrap" style={{ paddingTop: 16 }} id="prints-to-check">
      <div className="pane" style={{ marginBottom: 0 }}>
        <div className="section-head" style={{ marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>
              {shown.length} print{shown.length === 1 ? '' : 's'} to check
            </h3>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
              from your printer · oldest first · nothing reaches a project until you say how it came off
            </div>
          </div>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {only && (
              <span className="chip">
                {jobName(only) ?? 'one project'}{' '}
                <button type="button" className="linkbtn" style={{ width: 'auto', marginTop: 0 }} onClick={() => setSearch({})}>
                  show all
                </button>
              </span>
            )}
            {guessable.length > 0 && (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                title="Take Guma's guess of the project on every print that has one and no project yet. You still say how each came off."
                onClick={() => void Promise.all(guessable.map((r) => decide(r, { jobId: r.suggestedJobId })))}
              >
                Use the suggested project for {guessable.length}
              </button>
            )}
            <button type="button" className="btn sm primary" disabled={busy || ready.length === 0} onClick={() => void approve(ready.map((r) => r.id))}>
              {busy ? 'Approving…' : `Approve ${ready.length} ready`}
            </button>
          </span>
        </div>

        <Flash message={flash} />
        {error && (
          <div className="attn crit" role="alert" style={{ marginBottom: 8 }}>
            <span>{error}</span>
          </div>
        )}

        {list.map((row) => (
          <InboxCard
            key={row.id}
            ctx={ctx}
            row={row}
            jobs={jobs}
            assemblies={row.decision.jobId ? (assemblies[row.decision.jobId] ?? []) : []}
            busy={busy}
            onDecide={(p) => void decide(row, p)}
            onApprove={() => void approve([row.id])}
            onIgnore={() => void setAside(row)}
          />
        ))}
        {shown.length > FIRST && (
          <button type="button" className="linkbtn" style={{ width: 'auto' }} onClick={() => setAll((x) => !x)}>
            {all ? 'Show fewer' : `Show the other ${shown.length - FIRST}`}
          </button>
        )}
      </div>
    </div>
  )
}

function InboxCard({
  ctx,
  row,
  jobs,
  assemblies,
  busy,
  onDecide,
  onApprove,
  onIgnore,
}: {
  ctx: ShopContext
  row: InboxRow
  jobs: JobListRow[]
  assemblies: AssemblyRow[]
  busy: boolean
  onDecide: (patch: Partial<InboxDecision>) => void
  onApprove: () => void
  onIgnore: () => void
}) {
  const calls = objectCalls(row)
  const failed = calls.filter((c) => c.call === 'failed')
  const missing = notReady(row)
  const d = row.decision
  const decided = row.status !== 'new'
  const job = jobs.find((j) => j.jobId === d.jobId)
  const inhouse = job?.facts.kind === 'inhouse'
  const fileMaterial = row.materialText ?? 'the file’s'
  // Any answer here is the inspection: until one is given, nothing is
  // highlighted and the print cannot be approved.
  const setCall = (label: string, call: 'good' | 'failed') =>
    onDecide({ inspected: true, objects: { ...(d.objects ?? {}), ...Object.fromEntries(calls.map((c) => [c.label, c.call])), [label]: call } })
  const setAll = (call: 'good' | 'failed') => onDecide({ inspected: true, objects: Object.fromEntries(calls.map((c) => [c.label, call])) })
  const asked = !!d.inspected || decided
  const over = row.minutes != null && row.estMinutes != null && row.minutes > row.estMinutes * 1.5 + 10

  return (
    <div className="pane" data-testid={`inbox-${row.id}`} style={{ opacity: decided ? 0.7 : 1, marginBottom: 10, background: 'var(--bg)' }}>
      {/* What the printer said: facts, not choices. */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color: row.state === 'stopped' ? 'var(--warn)' : 'var(--ok)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          {row.state === 'stopped' ? 'STOPPED' : 'FINISHED'}
        </span>
        <b style={{ fontFamily: 'var(--mono)', fontSize: 12, wordBreak: 'break-all' }}>{row.fileName}</b>
        <span className="pmeta">
          ended {when(row.endedAt)} · ran {hm(row.minutes)}
          {row.estMinutes != null ? ` (sliced ${hm(row.estMinutes)})` : ''}
          {row.facts.job != null ? ` · Connect job ${row.facts.job}` : ''}
        </span>
        {decided && <span className="chip" style={{ marginLeft: 'auto' }}>{row.status === 'approved' ? 'approved' : 'set aside'}</span>}
      </div>
      {(row.facts.spools?.length || row.facts.cancelled?.length || row.facts.notes?.length || over) && (
        <div className="hint" style={{ marginTop: 4 }}>
          {row.facts.spools?.length ? `Spools: ${row.facts.spools.map((s) => `${s.name}${s.material ? ` (${s.material})` : ''} ${Math.round(s.grams * 10) / 10} g`).join(', ')}. ` : ''}
          {row.facts.cancelled?.length ? `Cancelled in Connect: ${row.facts.cancelled.join(', ')}. ` : ''}
          {over ? 'Ran far longer than sliced — paused, or left on the bed? ' : ''}
          {(row.facts.notes ?? []).join(' ')}
        </div>
      )}

      {!decided && (
        <div className="grid2" style={{ marginTop: 10, gap: 12 }}>
          <div className="fld">
            <label>Project</label>
            <select value={d.jobId ?? ''} onChange={(e) => onDecide({ jobId: e.target.value || null })} disabled={busy}>
              <option value="">— not decided —</option>
              {jobs.map((j) => (
                <option key={j.jobId} value={j.jobId}>
                  {j.ref} · {j.title}
                </option>
              ))}
            </select>
            {row.suggestedJobId && d.jobId !== row.suggestedJobId && (
              <div className="hint" style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span>
                  {d.jobId ? 'Guma guessed another: ' : 'Guma’s guess: '}
                  {row.suggestReason}
                </span>
                <button type="button" className="linkbtn" style={{ width: 'auto', marginTop: 0 }} onClick={() => onDecide({ jobId: row.suggestedJobId })}>
                  use {jobs.find((j) => j.jobId === row.suggestedJobId)?.ref ?? 'it'}
                </button>
              </div>
            )}
          </div>
          <div className="fld">
            <label>Spool it ran on</label>
            <select value={d.materialId ?? ''} onChange={(e) => onDecide({ materialId: e.target.value || null })} disabled={busy}>
              <option value="">As the file says ({fileMaterial})</option>
              {ctx.materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            {row.facts.spools?.length ? <div className="hint">Grams come from what the printer measured, not the file.</div> : null}
          </div>
        </div>
      )}

      {/* How it came off: always the person's call. */}
      <div className="objresults" role="group" aria-label={`How ${row.fileName} came off`} style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span className="lbl">How it came off{asked ? '' : ' — your inspection'}</span>
          {!decided && !asked && calls.length > 0 && (
            <button type="button" className="btn sm" onClick={() => setAll('good')}>
              ✓ All came off clean
            </button>
          )}
          {!decided && asked && calls.length > 1 && (
            <>
              <button type="button" className="linkbtn" style={{ width: 'auto', marginTop: 0, fontSize: 11 }} onClick={() => setAll('good')}>
                all good
              </button>
              <button type="button" className="linkbtn" style={{ width: 'auto', marginTop: 0, fontSize: 11 }} onClick={() => setAll('failed')}>
                all failed
              </button>
            </>
          )}
        </div>
        {calls.length === 0 && <div className="hint">Guma has no copy of the file, so it cannot list the objects.</div>}
        {calls.map((c) => {
          const o = row.objects?.find((x) => x.label === c.label)
          return (
            <div key={c.label} className={`objrow ${c.call === 'failed' ? 'failed' : ''}`.trim()}>
              <span style={{ flex: 1 }}>
                {c.label}
                {o && o.qty > 1 ? ` ×${o.qty}` : ''}
              </span>
              <span className="seg" role="group" aria-label={`How ${c.label} came off`}>
                <button type="button" disabled={decided} className={`segbtn printed ${asked && c.call === 'good' ? 'on' : ''}`} aria-pressed={asked && c.call === 'good'} onClick={() => setCall(c.label, 'good')}>
                  ✓ Good
                </button>
                <button type="button" disabled={decided} className={`segbtn reprint ${asked && c.call === 'failed' ? 'on' : ''}`} aria-pressed={asked && c.call === 'failed'} onClick={() => setCall(c.label, 'failed')}>
                  ✕ Failed
                </button>
              </span>
            </div>
          )
        })}
      </div>

      {!decided && !asked && (row.state === 'stopped' || row.facts.cancelled?.length) ? (
        <div className="hint" style={{ marginTop: 4 }}>
          {row.state === 'stopped' ? 'The printer stopped it part way' : `Connect cancelled ${row.facts.cancelled!.join(', ')}`} — did anything still come off?
        </div>
      ) : null}

      {!decided && asked && failed.length > 0 && (
        <div className="fld" style={{ marginTop: 8 }}>
          <label>Why it failed — it goes back on the build sheet to reprint</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {REASONS.map((r) => (
              <button key={r} type="button" className={`chip ${d.reason === r ? 'on' : ''}`} onClick={() => onDecide({ reason: r })}>
                {r}
              </button>
            ))}
          </div>
          <input value={d.reason ?? ''} placeholder="Or say it in your words" onChange={(e) => onDecide({ reason: e.target.value })} />
        </div>
      )}

      {!decided && inhouse && asked && failed.length < calls.length && (
        <div className="fld" style={{ marginTop: 8 }}>
          <label>The good pieces go</label>
          <select value={d.assemblyId ?? ''} onChange={(e) => onDecide({ assemblyId: e.target.value || null })} disabled={busy}>
            <option value="">Stay in Made — place them later</option>
            {assemblies
              .filter((a) => a.status === 'open')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  Into {a.name}
                </option>
              ))}
          </select>
        </div>
      )}

      <div className="btnrow" style={{ marginTop: 10, alignItems: 'center' }}>
        {!decided ? (
          <>
            <button type="button" className="btn sm primary" disabled={busy || !!missing} onClick={onApprove}>
              Approve
            </button>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={onIgnore} title="A calibration, a test, someone else's print — not part of any project.">
              Not a project
            </button>
            {missing && <span className="hint" style={{ marginTop: 0 }}>{missing}</span>}
          </>
) : (
          job && (
            <Link to={`/project/${job.jobId}`} className="linkbtn" style={{ width: 'auto' }}>
              On {job.ref} · {job.title} →
            </Link>
          )
        )}
      </div>
    </div>
  )
}
