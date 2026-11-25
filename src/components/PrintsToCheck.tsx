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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import * as data from '../lib/data'
import { listInbox, decideInbox, setInboxStatus, listJobs, listAssemblies, listClients, listShelf } from '../lib/data'
import type { AssemblyRow, ClientRow, InboxDecision, InboxRow, JobListRow, ProductRow, ShopContext } from '../lib/data.types'
import { placeOf } from '../lib/data.types'
import { startProject, type StartInput } from '../lib/startProject'
import { approveInbox, notReady, objectCalls } from '../lib/printInbox'
import { Flash, useFlash } from './Saving'
import { PrintPictures } from './PrintPhotos'

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
    const list = Array.isArray(r) ? r : []
    latest.current = Object.fromEntries(list.map((x) => [x.id, x.decision]))
    setRows(list)
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
    return j ? j.title : null
  }

  // Every save on this screen goes through one queue, in order, each built
  // on the newest answer for that print -- two quick changes to one print
  // each started from the print as drawn, so the second undid the first;
  // and Approve waits for the queue, so it never reads a print mid-save.
  const writes = useRef<Promise<unknown>>(Promise.resolve())
  const latest = useRef<Record<string, InboxDecision>>({})

  async function decide(row: InboxRow, patch: Partial<InboxDecision>) {
    const base = latest.current[row.id] ?? row.decision
    const next = { ...base, ...patch }
    // A new project means a new set of assemblies; an assembly chosen on
    // the old one is gone. The Shelf is the shop's, so it stays.
    if ('jobId' in patch && patch.jobId !== base.jobId) {
      next.assemblyId = null
      if (next.place?.kind === 'assembly') next.place = null
    }
    latest.current[row.id] = next
    setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...r, decision: next } : r)) ?? null)
    const write = writes.current.then(() => decideInbox(ctx.shop.id, row.id, next))
    writes.current = write.catch(() => {})
    try {
      await write
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await reload()
    }
  }

  async function approve(ids: string[]) {
    setBusy(true)
    setError(null)
    try {
      await writes.current
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

  /** A project made from the picker, and the other waiting prints whose
   *  file names carry its name -- offered, not filed (CG, 25 Nov: 18 prints
   *  of one 32-inch model, no project for them yet). */
  const [made, setMade] = useState<{ jobId: string; title: string } | null>(null)
  // Four letters or more: a short name ("Fins") would match unrelated files.
  const alike =
    made && made.title.length >= 4
      ? (rows ?? []).filter((r) => !r.decision.jobId && r.fileName.toLowerCase().includes(made.title.toLowerCase()))
      : []

  /** Several prints at once, one after another: saved together, SQLite
   *  turned some away as busy and those prints silently kept no project. */
  async function decideEach(list: InboxRow[], patch: (r: InboxRow) => Partial<InboxDecision>) {
    setBusy(true)
    try {
      for (const r of list) await decide(r, patch(r))
    } finally {
      setBusy(false)
    }
  }

  // What is on the Shelf, for "the good pieces go".
  const [products, setProducts] = useState<ProductRow[]>([])
  useEffect(() => {
    Promise.resolve()
      .then(() => listShelf(ctx.shop.id))
      .then((p) => setProducts(Array.isArray(p) ? p.filter((x) => !x.archived) : []), () => {})
  }, [ctx.shop.id, rows?.length])

  // Clients, for the "For a client" form -- read when first wanted.
  const [clients, setClients] = useState<ClientRow[] | null>(null)
  const wantClients = () => {
    if (clients) return
    Promise.resolve()
      .then(() => listClients(ctx.shop.id))
      .then((c) => setClients(c), () => setClients([]))
  }

  /** Start the project and file this print in it. True when it worked, so
   *  the form closes only then and keeps what was typed otherwise. */
  async function createFor(row: InboxRow, input: StartInput): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      const jobId = await startProject(ctx, data, input, 'Prints to check')
      setJobs(await listJobs(ctx.shop.id).then((j) => j.filter((x) => x.phase !== 'delivered')))
      if (input.kind === 'client') setClients(null)
      await decide(row, { jobId })
      const title = input.title.trim()
      setMade({ jobId, title })
      say(
        input.kind === 'client'
          ? `${title} started for ${(clients ?? []).find((c) => c.name.trim().toLowerCase() === input.clientName.trim().toLowerCase())?.name ?? input.clientName.trim()} — it is on the board at Intake, waiting for its quote.`
          : `${title} started as your own project.`,
      )
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
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
                onClick={() => void decideEach(guessable, (r) => ({ jobId: r.suggestedJobId }))}
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
        {made && alike.length > 0 && (
          <div className="attn warn" role="note" style={{ marginBottom: 8 }}>
            <span>
              {alike.length} other print{alike.length === 1 ? ' has' : 's have'} “{made.title}” in the file name.{' '}
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => {
                  const to = made.jobId
                  setMade(null)
                  void decideEach(alike, () => ({ jobId: to }))
                }}
              >
                File {alike.length === 1 ? 'it' : `all ${alike.length}`} in {made.title}
              </button>{' '}
              <button type="button" className="linkbtn" style={{ width: 'auto', marginTop: 0 }} onClick={() => setMade(null)}>
                no
              </button>
            </span>
          </div>
        )}
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
            onCreate={(input) => createFor(row, input)}
            clients={clients}
            wantClients={wantClients}
            products={products}
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
  onCreate,
  clients,
  wantClients,
  products,
}: {
  ctx: ShopContext
  row: InboxRow
  jobs: JobListRow[]
  assemblies: AssemblyRow[]
  busy: boolean
  onDecide: (patch: Partial<InboxDecision>) => void
  onApprove: () => void
  onIgnore: () => void
  onCreate: (input: StartInput) => Promise<boolean>
  clients: ClientRow[] | null
  wantClients: () => void
  products: ProductRow[]
}) {
  // The new-project form, open or not: what kind, its name, the client.
  const [naming, setNaming] = useState<{ kind: 'inhouse' | 'client'; title: string; client: string } | null>(null)
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const clash = naming && naming.title.trim() ? jobs.find((j) => same(j.title, naming.title)) : undefined
  const known = naming?.kind === 'client' && naming.client.trim() ? (clients ?? []).find((c) => same(c.name, naming.client)) : undefined
  const canCreate = !!naming && !!naming.title.trim() && !clash && (naming.kind === 'inhouse' || !!naming.client.trim())
  const listId = `clients-${row.id}`
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

      {/* The photo first: it is what the inspection is made from. */}
      <PrintPictures ctx={ctx} inboxId={row.id} />

      {!decided && (
        <div className="grid2" style={{ marginTop: 10, gap: 12 }}>
          <div className="fld">
            <label>Project</label>
            {/* Names only: the reference number is for paperwork, the name
                is how a project is found (CG, 25 Nov). The last option
                starts one, for a print whose project does not exist yet. */}
            {naming == null ? (
              <select
                value={d.jobId ?? ''}
                onChange={(e) => {
                  if (e.target.value === '__new') setNaming({ kind: 'inhouse', title: '', client: '' })
                  else onDecide({ jobId: e.target.value || null })
                }}
                disabled={busy}
              >
                <option value="">— not decided —</option>
                {jobs.map((j) => (
                  <option key={j.jobId} value={j.jobId}>
                    {j.title}
                  </option>
                ))}
                <option value="__new">+ New project…</option>
              </select>
            ) : (
              <form
                className="pane"
                style={{ margin: 0, padding: 10, display: 'grid', gap: 8 }}
                aria-label="Start a new project"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNaming(null)
                }}
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!canCreate || busy) return
                  const input: StartInput =
                    naming.kind === 'client'
                      ? { kind: 'client', title: naming.title, clientName: naming.client }
                      : { kind: 'inhouse', title: naming.title }
                  void onCreate(input).then((ok) => ok && setNaming(null))
                }}
              >
                <div className="seg" role="group" aria-label="Whose project">
                  <button type="button" aria-pressed={naming.kind === 'inhouse'} onClick={() => setNaming({ ...naming, kind: 'inhouse' })}>
                    Your own work
                  </button>
                  <button
                    type="button"
                    aria-pressed={naming.kind === 'client'}
                    onClick={() => {
                      wantClients()
                      setNaming({ ...naming, kind: 'client' })
                    }}
                  >
                    For a client
                  </button>
                </div>
                {naming.kind === 'client' && (
                  <div>
                    <input
                      list={listId}
                      value={naming.client}
                      placeholder="Client — pick one, or type a new name"
                      aria-label="Client"
                      onChange={(e) => setNaming({ ...naming, client: e.target.value })}
                    />
                    <datalist id={listId}>
                      {(clients ?? []).map((c) => (
                        <option key={c.id} value={c.name} />
                      ))}
                    </datalist>
                    {naming.client.trim() && (
                      <div className="hint">
                        {known ? `${known.name}, already in Clients — their details stay as they are.` : `A new client, “${naming.client.trim()}”. Add their details in Clients after.`}
                      </div>
                    )}
                  </div>
                )}
                <input
                  autoFocus
                  value={naming.title}
                  placeholder={naming.kind === 'client' ? 'What it is, e.g. Proa hull fittings' : 'Name the project, e.g. 32 Inch Wood Filled Model'}
                  aria-label="New project name"
                  onChange={(e) => setNaming({ ...naming, title: e.target.value })}
                />
                {clash && (
                  <div className="hint" style={{ color: 'var(--warn)' }}>
                    You already have “{clash.title}”.{' '}
                    <button
                      type="button"
                      className="linkbtn"
                      style={{ width: 'auto', marginTop: 0 }}
                      onClick={() => {
                        onDecide({ jobId: clash.jobId })
                        setNaming(null)
                      }}
                    >
                      use it
                    </button>
                  </div>
                )}
                <div className="hint" style={{ marginTop: 0 }}>
                  {naming.kind === 'client'
                    ? 'Goes on the board at Intake with an unpriced draft quote — it still needs quoting before it moves on.'
                    : 'Your own work: no quote, ready for plates and prints.'}
                </div>
                <div className="btnrow" style={{ marginTop: 0 }}>
                  <button type="submit" className="btn sm primary" disabled={busy || !canCreate}>
                    {busy ? 'Starting…' : 'Start it'}
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setNaming(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {row.suggestedJobId && d.jobId !== row.suggestedJobId && (
              <div className="hint" style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span>
                  {d.jobId ? 'Guma guessed another: ' : 'Guma’s guess: '}
                  {/* Rows saved before 25 Nov carry the reference number. */}
                  {(row.suggestReason ?? '').replace(/\b[A-Z]+-\d{4}-\d{4}\s/g, '')}
                </span>
                <button type="button" className="linkbtn" style={{ width: 'auto', marginTop: 0 }} onClick={() => onDecide({ jobId: row.suggestedJobId })}>
                  use {jobs.find((j) => j.jobId === row.suggestedJobId)?.title ?? 'it'}
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
          <SavedOnLeave label="Why it failed, in your words" value={d.reason ?? ''} placeholder="Or say it in your words" onSave={(v) => onDecide({ reason: v })} />
        </div>
      )}

      {!decided && inhouse && asked && failed.length < calls.length && (() => {
        // The same places the project's Made list sends pieces to.
        const place = placeOf(d)
        const value = !place ? '' : place.kind === 'kept' ? 'kept' : place.kind === 'assembly' ? `asm:${place.assemblyId}` : place.productId ? `shelf:${place.productId}` : 'shelf:new'
        const firstGood = calls.find((c) => c.call === 'good')?.label ?? ''
        const typed = place?.kind === 'shelf' && !place.productId ? (place.name ?? '') : ''
        const sameName = place?.kind === 'shelf' && !place.productId ? products.find((p) => p.name.trim().toLowerCase() === (typed.trim() || firstGood).trim().toLowerCase()) : undefined
        const openAsm = assemblies.filter((a) => a.status === 'open')
        return (
          <div className="fld" style={{ marginTop: 8 }}>
            <label>The good pieces go</label>
            <select
              value={value}
              disabled={busy}
              aria-label="Where the good pieces go"
              onChange={(e) => {
                const v = e.target.value
                if (!v) onDecide({ place: null, assemblyId: null })
                else if (v === 'kept') onDecide({ place: { kind: 'kept' }, assemblyId: null })
                else if (v === 'shelf:new') onDecide({ place: { kind: 'shelf', productId: null, name: '' }, assemblyId: null })
                else if (v.startsWith('shelf:')) onDecide({ place: { kind: 'shelf', productId: v.slice(6) }, assemblyId: null })
                else onDecide({ place: { kind: 'assembly', assemblyId: v.slice(4) }, assemblyId: null })
              }}
            >
              <option value="">Stay in Made — place them later</option>
              <optgroup label="The Shelf, to sell">
                <option value="shelf:new">A new product…</option>
                {products.map((p) => (
                  <option key={p.id} value={`shelf:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              {openAsm.length > 0 && (
                <optgroup label="Into an assembly">
                  {openAsm.map((a) => (
                    <option key={a.id} value={`asm:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value="kept">Keep — not for sale</option>
            </select>
            {place?.kind === 'shelf' && !place.productId && (
              <>
                <SavedOnLeave
                  style={{ marginTop: 6 }}
                  label="New product name"
                  value={typed}
                  placeholder={firstGood ? `Product name — blank uses “${firstGood}”` : 'Product name'}
                  onSave={(v) => onDecide({ place: { kind: 'shelf', productId: null, name: v } })}
                />
                <div className="hint">
                  {sameName
                    ? `“${sameName.name}” is already on the Shelf — these join it as a new batch.`
                    : 'A new product on the Shelf, costed from this print. Set its price on the Shelf.'}
                </div>
              </>
            )}
            {place?.kind === 'shelf' && place.productId && <div className="hint">A new batch of it on the Shelf, costed from this print.</div>}
            {place?.kind === 'kept' && <div className="hint">Yours to keep — not for sale.</div>}
          </div>
        )
      })()}

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
              On {job.title} →
            </Link>
          )
        )}
      </div>
    </div>
  )
}

/** A text box that saves when you leave it or press Enter, not on every
 *  key: each save is a database write, and a burst of them could land out
 *  of order (25 Nov). Follows the saved value when it changes elsewhere. */
function SavedOnLeave({
  value,
  onSave,
  label,
  placeholder,
  style,
}: {
  value: string
  onSave: (v: string) => void
  label: string
  placeholder?: string
  style?: React.CSSProperties
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    if (text !== value) onSave(text)
  }
  return (
    <input
      style={style}
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
    />
  )
}
