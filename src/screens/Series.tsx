/**
 * Series -- the shop's own body of work, held the way a client holds the
 * projects they bring in.
 *
 * CG, 30 Sept: "Maui can be under the BathyTopo series and move along the
 * phases as it gets completed." The old "program" was a project that other
 * projects sat under, so BathyTopo itself had stages and gates it could
 * never meaningfully pass. A series has none: it is a name, a brief, the
 * series inside it, and its pieces -- each an ordinary project moving
 * through its own stages, forwards or back.
 *
 * Two routes, one screen: /series lists them, /series/:seriesId opens one.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  createInHouseJob,
  createSeries,
  listJobs,
  listSeries,
  updateSeries,
  type JobListRow,
  type SeriesRow,
  type ShopContext,
} from '../lib/data'
import { phaseLabel } from '../lib/gates'
import { makeMoney } from '../lib/pricing'
import { fmtHours } from '../lib/duration'
import {
  eligibleSeriesParents,
  piecesOf,
  seriesAncestors,
  seriesChildren,
  seriesPath,
  seriesTotals,
} from '../lib/series'
import type { ProgramTotals } from '../lib/programs'

export default function Series({ ctx }: { ctx: ShopContext }) {
  const { seriesId } = useParams()
  const [all, setAll] = useState<SeriesRow[] | null>(null)
  const [rows, setRows] = useState<JobListRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([listSeries(ctx.shop.id), listJobs(ctx.shop.id)])
      setAll(s)
      setRows(j)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [ctx.shop.id])

  useEffect(() => {
    void reload()
  }, [reload])

  // The same page frame every other screen uses: a centred column with
  // the shared gutters. Without it this page ran edge to edge (CG, 9 Oct).
  const frame = (body: React.ReactNode) => (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 32 }}>
      {error && (
        <div className="alert" style={{ marginBottom: 10 }}>
          <span>{error}</span>
        </div>
      )}
      {body}
    </div>
  )
  if (!all || !rows) return frame(error ? null : <div className="hint">Loading…</div>)
  if (seriesId) {
    const one = all.find((s) => s.id === seriesId)
    if (!one) return frame(<div className="attn crit">That series is not in this shop.</div>)
    return frame(<OneSeries ctx={ctx} series={one} all={all} rows={rows} onChanged={reload} setError={setError} />)
  }
  return frame(<AllSeries ctx={ctx} all={all} rows={rows} onChanged={reload} setError={setError} />)
}

function Tiles({ t, ctx }: { t: ProgramTotals; ctx: ShopContext }) {
  const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)
  const g = (n: number) => `${Math.round(n)} g`
  const h = (n: number) => fmtHours(n)
  return (
    <div className="dtiles" style={{ margin: 0 }}>
      <div className="dtile biolum">
        <span className="dt-lab">Pieces</span>
        <span className="dt-v">{t.projects}</span>
        <span className="dt-sub">{t.done} finished</span>
      </div>
      <div className="dtile ember">
        <span className="dt-lab">Cost so far</span>
        <span className="dt-v">{money(t.cost)}</span>
        <span className="dt-sub">material, machine, wear, power, hours</span>
      </div>
      <div className="dtile teal">
        <span className="dt-lab">Printed</span>
        <span className="dt-v">{g(t.materialUnits)}</span>
        <span className="dt-sub">
          {t.runs} run{t.runs === 1 ? '' : 's'} · {h(t.machineHours)} machine
          {t.failedUnits > 0 ? ` · ${g(t.failedUnits)} failed` : ''}
        </span>
      </div>
      <div className="dtile violet">
        <span className="dt-lab">Your time</span>
        <span className="dt-v">{h(t.hours)}</span>
        <span className="dt-sub">design, finishing and admin</span>
      </div>
    </div>
  )
}

function AllSeries({
  ctx,
  all,
  rows,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  all: SeriesRow[]
  rows: JobListRow[]
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const live = all.filter((s) => showArchived || !s.archivedAt)
  const top = seriesChildren(live, null)
  // One series is opened for you; with several, they start folded so the
  // page reads as a list of bodies of work, not a wall of tables.
  const [open, setOpen] = useState<Set<string>>(() => new Set(top.length === 1 ? [top[0].id] : []))
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)
  const totalPieces = new Set(rows.filter((r) => r.facts.seriesId).map((r) => r.jobId)).size

  async function create() {
    if (!name.trim()) return
    try {
      const id = await createSeries(ctx.shop.id, { name })
      setName('')
      setAdding(false)
      await onChanged()
      navigate(`/series/${id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function addPiece(seriesId: string, title: string) {
    try {
      const id = await createInHouseJob(ctx.shop.id, { title, seriesId })
      navigate(`/project/${id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const renderTree = (parent: string | null, depth: number): React.ReactNode =>
    seriesChildren(live, parent).map((s) => (
      <SeriesCard
        key={s.id}
        series={s}
        depth={depth}
        open={open.has(s.id)}
        onToggle={() => toggle(s.id)}
        totals={seriesTotals(rows, all, s.id)}
        pieces={piecesOf(rows, s.id)}
        money={money}
        onAddPiece={(t) => void addPiece(s.id, t)}
      >
        {renderTree(s.id, depth + 1)}
      </SeriesCard>
    ))

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Series</h2>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--txt-3)',
              marginTop: 3,
            }}
          >
            {live.length} series · {totalPieces} piece
            {totalPieces === 1 ? '' : 's'} · your own bodies of work, each piece a project with its own stages
          </div>
        </div>
        <button
          type="button"
          className="btn primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? 'Cancel' : 'Start a series'}
        </button>
      </div>

      {adding && (
        <div className="pane" style={{ marginBottom: 12 }}>
          <div className="btnrow" style={{ alignItems: 'flex-end', margin: 0 }}>
            <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220, maxWidth: 480 }}>
              <label className="lbl" htmlFor="new-series">
                Series name
              </label>
              <input
                id="new-series"
                value={name}
                autoFocus
                placeholder="BathyTopo, Sakman models, Keychains…"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create()
                }}
              />
            </div>
            <button type="button" className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
              Start it
            </button>
          </div>
        </div>
      )}

      {live.length === 0 ? (
        <div className="pane">
          <div className="hint" style={{ marginTop: 0 }}>
            No series yet. Start one, then add pieces to it — each piece moves through its own stages.
          </div>
        </div>
      ) : (
        <div className="serieslist">{renderTree(null, 0)}</div>
      )}
      {all.some((s) => s.archivedAt) && (
        <button
          type="button"
          className="linkbtn"
          style={{ marginTop: 10, width: 'auto' }}
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? 'Hide archived series' : 'Show archived series'}
        </button>
      )}
    </>
  )
}

/**
 * One series, folded to a single row: name, what is in it, what it has
 * cost. Open it and its pieces are listed with their stage and figures,
 * with a line to add another -- the series inside it nest below (CG, 9 Oct:
 * "each series a dropdown ... including what is within it").
 */
function SeriesCard({
  series,
  depth,
  open,
  onToggle,
  totals,
  pieces,
  money,
  onAddPiece,
  children,
}: {
  series: SeriesRow
  depth: number
  open: boolean
  onToggle: () => void
  totals: ProgramTotals
  pieces: JobListRow[]
  money: (n: number) => string
  onAddPiece: (title: string) => void
  children: React.ReactNode
}) {
  const [piece, setPiece] = useState('')
  const inProgress = pieces.filter((r) => r.phase !== 'delivered').length
  return (
    <div className={`seriescard ${open ? 'open' : ''}`.trim()} style={depth ? { marginLeft: depth * 22 } : undefined}>
      <div className="serieshead">
        <button
          type="button"
          className="chevbtn"
          aria-expanded={open}
          aria-label={`${open ? 'Fold' : 'Show'} ${series.name}`}
          onClick={onToggle}
        >
          {open ? '▾' : '▸'}
        </button>
        <div className="seriesname" onClick={onToggle}>
          <span className="pn">{series.name}</span>
          {series.archivedAt && <span className="chip">archived</span>}
          {series.brief && <span className="pmeta">{series.brief}</span>}
        </div>
        <div className="seriesfigs">
          <span>
            <b>{totals.projects}</b> piece{totals.projects === 1 ? '' : 's'}
          </span>
          <span>
            <b>{totals.done}</b> finished
          </span>
          <span>
            <b>{money(totals.cost)}</b> so far
          </span>
        </div>
        <Link
          to={`/series/${series.id}`}
          className="btn sm"
          aria-label={`Open ${series.name}`}
          style={{ textDecoration: 'none' }}
        >
          Open
        </Link>
      </div>
      {open && (
        <div className="seriesbody">
          {pieces.length === 0 ? (
            <div className="hint" style={{ marginTop: 0 }}>
              Nothing filed directly in {series.name} yet.
            </div>
          ) : (
            <div className="sheetwrap" style={{ maxHeight: 'none' }}>
              <table>
                <thead>
                  <tr>
                    <th>Piece</th>
                    <th>Stage</th>
                    <th className="r">Printed</th>
                    <th className="r">Machine</th>
                    <th className="r">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {pieces.map((r) => (
                    <tr key={r.jobId}>
                      <td>
                        <Link to={`/project/${r.jobId}`} className="pn" style={{ textDecoration: 'none' }}>
                          {r.title}
                        </Link>
                        <span className="pmeta" style={{ marginLeft: 8 }}>
                          {r.ref}
                          {r.facts.archivedAt ? ' · archived' : ''}
                        </span>
                      </td>
                      <td>
                        <span className={`chip ${r.phase === 'delivered' ? 'done' : ''}`.trim()}>{r.phase === 'delivered' ? '✓ ' : ''}{phaseLabel(r.phase, r.facts.kind)}</span>
                      </td>
                      <td className="r mono">
                        {r.facts.materialUnits ? `${Math.round(r.facts.materialUnits)} g` : '—'}
                      </td>
                      <td className="r mono">
                        {r.facts.machineHours ? fmtHours(r.facts.machineHours) : '—'}
                      </td>
                      <td className="r mono">{r.facts.actualCost ? money(r.facts.actualCost) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="btnrow" style={{ marginTop: 10, alignItems: 'flex-end' }}>
            <div className="fld" style={{ margin: 0, flex: 1, minWidth: 200, maxWidth: 420 }}>
              <label className="lbl" htmlFor={`add-piece-${series.id}`}>
                Add a piece to {series.name}
              </label>
              <input
                id={`add-piece-${series.id}`}
                value={piece}
                placeholder="Maui, Oʻahu, Viti Levu…"
                onChange={(e) => setPiece(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && piece.trim()) onAddPiece(piece.trim())
                }}
              />
            </div>
            <button
              type="button"
              className="btn sm primary"
              disabled={!piece.trim()}
              onClick={() => onAddPiece(piece.trim())}
            >
              Start the piece
            </button>
            {inProgress > 0 && (
              <span className="pmeta" style={{ marginLeft: 'auto' }}>
                {inProgress} in progress
              </span>
            )}
          </div>
        </div>
      )}
      {children}
    </div>
  )
}

function OneSeries({
  ctx,
  series,
  all,
  rows,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  series: SeriesRow
  all: SeriesRow[]
  rows: JobListRow[]
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const navigate = useNavigate()
  const [piece, setPiece] = useState('')
  const [sub, setSub] = useState('')
  const [openKids, setOpenKids] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(series.name)
  const [draftBrief, setDraftBrief] = useState(series.brief ?? '')
  const [showDone, setShowDone] = useState(true)
  const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)

  const path = seriesAncestors(all, series.id)
  const kids = seriesChildren(all, series.id).filter((s) => !s.archivedAt)
  const pieces = piecesOf(rows, series.id).filter((r) => showDone || r.phase !== 'delivered')
  const total = seriesTotals(rows, all, series.id)

  async function guard(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <div className="pmeta" style={{ marginBottom: 6 }}>
        <Link to="/series" style={{ color: 'var(--txt-2)' }}>
          Series
        </Link>
        {path.map((p) => (
          <span key={p.id}>
            {' › '}
            <Link to={`/series/${p.id}`} style={{ color: 'var(--txt-2)' }}>
              {p.name}
            </Link>
          </span>
        ))}
      </div>

      {editing ? (
        <div className="pane">
          <div className="fld">
            <label className="lbl" htmlFor="series-name">
              Series name
            </label>
            <input id="series-name" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          </div>
          <div className="fld">
            <label className="lbl" htmlFor="series-brief">
              What it is
            </label>
            <textarea id="series-brief" rows={2} value={draftBrief} onChange={(e) => setDraftBrief(e.target.value)} />
          </div>
          <div className="btnrow">
            <button
              type="button"
              className="btn sm primary"
              disabled={!draftName.trim()}
              onClick={() =>
                void guard(async () => {
                  await updateSeries(ctx.shop.id, series.id, {
                    name: draftName,
                    brief: draftBrief,
                  })
                  setEditing(false)
                })
              }
            >
              Save
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="section-head">
          <div>
            <h2>
              {series.name}
              {series.archivedAt && (
                <span className="chip" style={{ marginLeft: 8 }}>
                  archived
                </span>
              )}
            </h2>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--txt-3)',
                marginTop: 3,
              }}
            >
              {series.brief ?? 'A series of your own work.'}
            </div>
          </div>
          <button
            type="button"
            className="btn sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              setDraftName(series.name)
              setDraftBrief(series.brief ?? '')
              setEditing(true)
            }}
          >
            Edit name
          </button>
        </div>
      )}

      <div className="pane">
        <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
          Everything in {series.name}
          {kids.length ? ' and the series inside it' : ''}, added up. Each piece keeps its own figures.
        </div>
        <Tiles t={total} ctx={ctx} />
      </div>

      <div className="sechead" style={{ marginTop: 18 }}>
        <h4>Pieces</h4>
        <span className="sub">
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show finished
          </label>
        </span>
      </div>
      {pieces.length === 0 ? (
        <div className="hint">Nothing filed directly in {series.name} yet.</div>
      ) : (
        <div className="sheetwrap" style={{ maxHeight: 'none' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: '40%' }}>Piece</th>
                <th>Stage</th>
                <th className="r">Printed</th>
                <th className="r">Machine</th>
                <th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {pieces.map((r) => (
                <tr key={r.jobId}>
                  <td>
                    <Link to={`/project/${r.jobId}`} className="pn" style={{ textDecoration: 'none' }}>
                      {r.title}
                    </Link>
                    <span className="pmeta" style={{ marginLeft: 8 }}>
                      {r.ref}
                      {r.facts.kind !== 'inhouse' && r.clientName ? ` · for ${r.clientName}` : ''}
                      {r.facts.archivedAt ? ' · archived' : ''}
                    </span>
                  </td>
                  <td>
                    <span className={`chip ${r.phase === 'delivered' ? 'done' : ''}`.trim()}>{r.phase === 'delivered' ? '✓ ' : ''}{phaseLabel(r.phase, r.facts.kind)}</span>
                  </td>
                  <td className="r mono">{r.facts.materialUnits ? `${Math.round(r.facts.materialUnits)} g` : '—'}</td>
                  <td className="r mono">
                    {r.facts.machineHours ? fmtHours(r.facts.machineHours) : '—'}
                  </td>
                  <td className="r mono">{r.facts.actualCost ? money(r.facts.actualCost) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="btnrow" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220, maxWidth: 420 }}>
          <label className="lbl" htmlFor="new-piece">
            Add a piece to {series.name}
          </label>
          <input
            id="new-piece"
            value={piece}
            placeholder="Maui, Oʻahu, Viti Levu…"
            onChange={(e) => setPiece(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn sm primary"
          disabled={!piece.trim()}
          onClick={() =>
            void guard(async () => {
              const id = await createInHouseJob(ctx.shop.id, {
                title: piece,
                seriesId: series.id,
              })
              setPiece('')
              navigate(`/project/${id}`)
            })
          }
        >
          Start the piece
        </button>
      </div>

      <div className="sechead" style={{ marginTop: 22 }}>
        <h4>Series inside {series.name}</h4>
      </div>
      {kids.length === 0 ? (
        <div className="hint">None yet — a series can hold others, like BathyTopo › Hawaiian Islands.</div>
      ) : (
        <div className="serieslist">
          {kids.map((k) => (
            <SeriesCard
              key={k.id}
              series={k}
              depth={0}
              open={openKids.has(k.id)}
              onToggle={() =>
                setOpenKids((cur) => {
                  const next = new Set(cur)
                  if (next.has(k.id)) next.delete(k.id)
                  else next.add(k.id)
                  return next
                })
              }
              totals={seriesTotals(rows, all, k.id)}
              pieces={piecesOf(rows, k.id)}
              money={money}
              onAddPiece={(title) =>
                void guard(async () => {
                  const id = await createInHouseJob(ctx.shop.id, {
                    title,
                    seriesId: k.id,
                  })
                  navigate(`/project/${id}`)
                })
              }
            >
              {null}
            </SeriesCard>
          ))}
        </div>
      )}
      <div className="btnrow" style={{ marginTop: 10, alignItems: 'flex-end' }}>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220, maxWidth: 420 }}>
          <label className="lbl" htmlFor="new-sub">
            Start a series inside {series.name}
          </label>
          <input
            id="new-sub"
            value={sub}
            placeholder="Hawaiian Islands, Fiji, French Polynesia…"
            onChange={(e) => setSub(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn sm"
          disabled={!sub.trim()}
          onClick={() =>
            void guard(async () => {
              await createSeries(ctx.shop.id, {
                name: sub,
                parentId: series.id,
              })
              setSub('')
            })
          }
        >
          Start it
        </button>
      </div>

      <div className="sechead" style={{ marginTop: 22 }}>
        <h4>Where it sits</h4>
      </div>
      <div className="btnrow" style={{ alignItems: 'flex-end' }}>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220, maxWidth: 420 }}>
          <label className="lbl" htmlFor="series-parent">
            Sits inside
          </label>
          <select
            id="series-parent"
            value={series.parentId ?? ''}
            onChange={(e) =>
              void guard(() =>
                updateSeries(ctx.shop.id, series.id, {
                  parentId: e.target.value || null,
                }),
              )
            }
          >
            <option value="">Nothing — a top-level series</option>
            {eligibleSeriesParents(all, series.id).map((s) => (
              <option key={s.id} value={s.id}>
                {seriesPath(all, s.id)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() =>
            void guard(() =>
              updateSeries(ctx.shop.id, series.id, {
                archived: !series.archivedAt,
              }),
            )
          }
        >
          {series.archivedAt ? 'Unarchive this series' : 'Archive this series'}
        </button>
      </div>
    </div>
  )
}
