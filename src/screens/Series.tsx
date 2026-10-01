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

  if (error) return <div className="attn crit">{error}</div>
  if (!all || !rows) return <div className="hint">Loading…</div>
  if (seriesId) {
    const one = all.find((s) => s.id === seriesId)
    if (!one) return <div className="attn crit">That series is not in this shop.</div>
    return <OneSeries ctx={ctx} series={one} all={all} rows={rows} onChanged={reload} setError={setError} />
  }
  return <AllSeries ctx={ctx} all={all} rows={rows} onChanged={reload} setError={setError} />
}

function Tiles({ t, ctx }: { t: ProgramTotals; ctx: ShopContext }) {
  const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)
  const g = (n: number) => `${Math.round(n)} g`
  const h = (n: number) => `${Math.round(n * 10) / 10} h`
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
  const [showArchived, setShowArchived] = useState(false)
  const live = all.filter((s) => showArchived || !s.archivedAt)

  async function create() {
    if (!name.trim()) return
    try {
      const id = await createSeries(ctx.shop.id, { name })
      setName('')
      await onChanged()
      navigate(`/series/${id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const renderTree = (parent: string | null, depth: number): React.ReactNode =>
    seriesChildren(live, parent).map((s) => {
      const t = seriesTotals(rows, all, s.id)
      return (
        <div key={s.id}>
          <Link
            to={`/series/${s.id}`}
            className="pane"
            style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginLeft: depth * 22, marginTop: 8, textDecoration: 'none' }}
          >
            <span>
              <span className="pn">{s.name}</span>
              {s.archivedAt && <span className="chip" style={{ marginLeft: 8 }}>archived</span>}
              {s.brief && <div className="pmeta">{s.brief}</div>}
            </span>
            <span className="pmeta" style={{ whiteSpace: 'nowrap' }}>
              {t.projects} piece{t.projects === 1 ? '' : 's'} · {t.done} finished
            </span>
          </Link>
          {renderTree(s.id, depth + 1)}
        </div>
      )
    })

  return (
    <div>
      <div className="dlg-title" style={{ alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 18 }}>Series</h3>
        <span className="pmeta">
          Your own bodies of work. Each piece is a project with its own stages; the series adds them up.
        </span>
      </div>
      <div className="btnrow" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220 }}>
          <label className="lbl" htmlFor="new-series">
            Start a series
          </label>
          <input
            id="new-series"
            value={name}
            placeholder="BathyTopo, Sakman models, Keychains…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
          />
        </div>
        <button type="button" className="btn sm primary" disabled={!name.trim()} onClick={() => void create()}>
          Start it
        </button>
      </div>
      {live.length === 0 ? (
        <div className="hint" style={{ marginTop: 14 }}>
          No series yet. Start one, then add pieces to it — each piece moves through its own stages.
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>{renderTree(null, 0)}</div>
      )}
      {all.some((s) => s.archivedAt) && (
        <button type="button" className="linkbtn" style={{ marginTop: 10 }} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Hide archived series' : 'Show archived series'}
        </button>
      )}
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
                  await updateSeries(ctx.shop.id, series.id, { name: draftName, brief: draftBrief })
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
        <div className="dlg-title" style={{ alignItems: 'baseline' }}>
          <h3 style={{ fontSize: 18 }}>
            {series.name}{' '}
            <button
              type="button"
              className="linkbtn"
              style={{ fontSize: 11, fontWeight: 400 }}
              onClick={() => {
                setDraftName(series.name)
                setDraftBrief(series.brief ?? '')
                setEditing(true)
              }}
            >
              edit
            </button>
          </h3>
          <span className="pmeta">{series.brief ?? 'A series of your own work.'}</span>
        </div>
      )}

      <div className="pane" style={{ marginTop: 12 }}>
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
                    <div className="pmeta">
                      {r.ref}
                      {r.facts.archivedAt ? ' · archived' : ''}
                    </div>
                  </td>
                  <td>
                    <span className="chip">{phaseLabel(r.phase, r.facts.kind)}</span>
                  </td>
                  <td className="r mono">{r.facts.materialUnits ? `${Math.round(r.facts.materialUnits)} g` : '—'}</td>
                  <td className="r mono">
                    {r.facts.machineHours ? `${Math.round(r.facts.machineHours * 10) / 10} h` : '—'}
                  </td>
                  <td className="r mono">{r.facts.actualCost ? money(r.facts.actualCost) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="btnrow" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220 }}>
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
              const id = await createInHouseJob(ctx.shop.id, { title: piece, seriesId: series.id })
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
      {kids.map((k) => {
        const t = seriesTotals(rows, all, k.id)
        return (
          <Link
            key={k.id}
            to={`/series/${k.id}`}
            className="pane"
            style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, textDecoration: 'none' }}
          >
            <span className="pn">{k.name}</span>
            <span className="pmeta">
              {t.projects} piece{t.projects === 1 ? '' : 's'} · {t.done} finished
            </span>
          </Link>
        )
      })}
      <div className="btnrow" style={{ marginTop: 10, alignItems: 'flex-end' }}>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 220 }}>
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
              await createSeries(ctx.shop.id, { name: sub, parentId: series.id })
              setSub('')
            })
          }
        >
          Start it
        </button>
      </div>

      <div className="btnrow" style={{ marginTop: 22, alignItems: 'center' }}>
        <label className="lbl" htmlFor="series-parent" style={{ margin: 0 }}>
          Sits inside
        </label>
        <select
          id="series-parent"
          value={series.parentId ?? ''}
          onChange={(e) =>
            void guard(() => updateSeries(ctx.shop.id, series.id, { parentId: e.target.value || null }))
          }
        >
          <option value="">Nothing — a top-level series</option>
          {eligibleSeriesParents(all, series.id).map((s) => (
            <option key={s.id} value={s.id}>
              {seriesPath(all, s.id)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => void guard(() => updateSeries(ctx.shop.id, series.id, { archived: !series.archivedAt }))}
        >
          {series.archivedAt ? 'Unarchive this series' : 'Archive this series'}
        </button>
      </div>
    </div>
  )
}
