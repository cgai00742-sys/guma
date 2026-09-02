/**
 * Projects — the flat list view, the board's other half.
 *
 * The board (Pipeline.tsx) answers "where is everything?" by shape. This
 * answers "what is wrong, and what is it worth?" by column: stage, flags,
 * gate progress, quoted, and owed, all sortable, all on one screen. Both
 * read the same listJobs rows and the same gates.ts logic, so the two can
 * disagree about a project only if the data changed between loads.
 *
 * A row opens the project page, not the quote PDF. The PDF is a secondary
 * action on rows that have one: a draft quote carries no rates_snapshot
 * (see data.local.ts's loadQuoteForPrint), so linking a draft to the print
 * view is exactly the blank-screen bug from before. Drafts get a plain-
 * language reason instead of a link that breaks.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { makeMoney } from '../lib/pricing'
import {
  deleteProject,
  listJobs,
  takeProjectIn,
  toRateSet,
  type JobListRow,
  type ShopContext,
} from '../lib/data'
import { PHASE_LABEL, flagsFor, gateStatus, worstTone, type Flag } from '../lib/gates'

type SortKey = 'saved' | 'stage' | 'due' | 'value' | 'owed' | 'flags'
type Show = 'live' | 'drafts' | 'all'

interface Row extends JobListRow {
  flags: Flag[]
  gateDone: number
  gateTotal: number
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
}

function statusColor(status: string | null): string {
  if (status === 'accepted') return 'var(--ok)'
  if (status === 'sent') return 'var(--biolum)'
  if (status === 'declined' || status === 'expired') return 'var(--red)'
  return 'var(--warn)' // draft, or no quote at all
}

export default function Jobs({ ctx, viewSwitch }: { ctx: ShopContext; viewSwitch?: React.ReactNode }) {
  const navigate = useNavigate()
  const rates = useMemo(() => toRateSet(ctx.rateCard, ctx.shop), [ctx.rateCard, ctx.shop])
  const { money } = useMemo(() => makeMoney(rates.currency, rates.locale), [rates.currency, rates.locale])

  const [jobs, setJobs] = useState<JobListRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const dateFmt = (iso: string) =>
    new Date(iso).toLocaleDateString(rates.locale, { day: 'numeric', month: 'short', year: 'numeric' })

  const [sort, setSort] = useState<SortKey>('saved')
  // The list is where drafts live, since the board deliberately excludes
  // them. Kept in the URL so the board's "N drafts" chip can link straight
  // at them.
  const [params, setParams] = useSearchParams()
  const show: Show = (['live', 'drafts', 'all'] as const).includes(params.get('show') as Show)
    ? (params.get('show') as Show)
    : 'live'
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function setShow(next: Show) {
    const p = new URLSearchParams(params)
    if (next === 'live') p.delete('show')
    else p.set('show', next)
    setParams(p, { replace: true })
  }

  async function refresh() {
    setJobs(await listJobs(ctx.shop.id))
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
      setConfirming(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Flags and gate progress come from the same pure functions the board
   *  uses, over the same rows — there is no second opinion here. */
  const rows: Row[] = useMemo(
    () =>
      (jobs ?? []).map((j) => {
        const gate = gateStatus(j.phase, j.gateAnswers, j.facts)
        return { ...j, flags: flagsFor(j.facts), gateDone: gate.done, gateTotal: gate.total }
      }),
    [jobs],
  )

  const sorted = useMemo(() => {
    const rank = { crit: 0, warn: 1, info: 2 } as const
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      saved: (a, b) => b.createdAt.localeCompare(a.createdAt),
      stage: (a, b) => a.phase.localeCompare(b.phase) || b.createdAt.localeCompare(a.createdAt),
      due: (a, b) => (a.facts.neededBy ?? '9999').localeCompare(b.facts.neededBy ?? '9999'),
      value: (a, b) => (b.total ?? 0) - (a.total ?? 0),
      owed: (a, b) => b.facts.balanceOwed - a.facts.balanceOwed,
      flags: (a, b) => {
        const at = worstTone(a.flags)
        const bt = worstTone(b.flags)
        return (at ? rank[at] : 9) - (bt ? rank[bt] : 9) || b.flags.length - a.flags.length
      },
    }
    const visible = rows.filter((r) =>
      show === 'all' ? true : show === 'drafts' ? !r.facts.takenInAt : !!r.facts.takenInAt,
    )
    return [...visible].sort(by[sort])
  }, [rows, sort, show])

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <div className="section-head">
        <div>
          <h2>Projects</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            {jobs
              ? `${rows.filter((r) => r.facts.takenInAt).length} on the board · ${rows.filter((r) => !r.facts.takenInAt).length} draft · ${money(rows.reduce((n, r) => n + r.facts.balanceOwed, 0))} owed`
              : 'Loading…'}
          </div>
        </div>
        {viewSwitch}
        <Link to="/intake" className="btn primary" style={{ textDecoration: 'none' }}>
          New project
        </Link>
      </div>

      {error && (
        <div className="alert">
          <span>{error}</span>
        </div>
      )}

      {/* Keyed off the FILTERED rows, not the raw count: filtering to
          Drafts when there are none used to render an empty table with no
          explanation at all. */}
      {!error && jobs && sorted.length === 0 && (
        <div className="pane" style={{ textAlign: 'center', color: 'var(--txt-3)', padding: '32px 16px' }}>
          {jobs.length === 0
            ? 'Nothing saved yet. Every project you save from New project shows up here, drafts included.'
            : show === 'drafts'
              ? 'No drafts. A draft is a project saved without being taken in — priced and findable, but kept off the board.'
              : show === 'live'
                ? 'Nothing on the board. Everything saved so far is still a draft — switch to Drafts to take one in.'
                : 'Nothing matches.'}
        </div>
      )}

      {!error && jobs && sorted.length > 0 && (
        <>
          <div className="filters" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
            <div className="seg" role="group" aria-label="Which projects to show">
              {(
                [
                  ['live', 'On the board'],
                  ['drafts', 'Drafts'],
                  ['all', 'Everything'],
                ] as [Show, string][]
              ).map(([v, label]) => (
                <button key={v} type="button" aria-pressed={show === v} onClick={() => setShow(v)}>
                  {label}
                </button>
              ))}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span style={{ color: 'var(--txt-3)' }}>Sort by</span>
              <select
                value={sort}
                style={{ width: 'auto' }}
                onChange={(e) => setSort(e.target.value as SortKey)}
              >
                <option value="saved">Recently saved</option>
                <option value="flags">Worst flags first</option>
                <option value="due">Due soonest</option>
                <option value="owed">Most owed</option>
                <option value="value">Largest quote</option>
                <option value="stage">Stage</option>
              </select>
            </label>
          </div>

          <div className="pane" style={{ padding: 0, overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Project</th>
                  <th>Stage</th>
                  <th>Flags</th>
                  <th className="r">Gate</th>
                  <th>Quote</th>
                  <th className="r">Total</th>
                  <th className="r">Owed</th>
                  <th>Due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((j) => {
                  const hasDoc = (j.quoteStatus === 'sent' || j.quoteStatus === 'accepted') && j.quoteId
                  return (
                    <tr
                      key={j.jobId}
                      className="row"
                      title="Open this project"
                      onClick={() => navigate(`/project/${j.jobId}`)}
                    >
                      <td style={{ fontFamily: 'var(--mono)', color: 'var(--txt-3)' }}>{j.ref}</td>
                      <td>
                        <div style={{ fontWeight: 500, color: 'var(--txt)' }}>{j.title}</div>
                        <div className="pmeta">{j.clientName}</div>
                      </td>
                      <td>
                        {j.facts.takenInAt ? (
                          <span className="chip">{PHASE_LABEL[j.phase]}</span>
                        ) : (
                          <span
                            className="chip"
                            style={{
                              color: 'var(--warn)',
                              borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)',
                            }}
                            title="Saved but not taken in, so it is not on the board."
                          >
                            Draft
                          </span>
                        )}
                      </td>
                      <td>
                        {j.flags.length === 0 ? (
                          <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>clear</span>
                        ) : (
                          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                            {j.flags.map((f) => (
                              <span
                                key={f.key}
                                className={`flagtag ${f.tone}`}
                                title={`${f.cause} ${f.action}`}
                                style={{
                                  color:
                                    f.tone === 'crit'
                                      ? 'var(--red)'
                                      : f.tone === 'warn'
                                        ? 'var(--warn)'
                                        : 'var(--info)',
                                  borderColor: 'currentColor',
                                }}
                              >
                                {f.label}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="r mono" style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                        {j.gateTotal > 0 ? `${j.gateDone}/${j.gateTotal}` : '—'}
                      </td>
                      <td>
                        <span
                          className="chip"
                          style={{
                            color: statusColor(j.quoteStatus),
                            borderColor: `color-mix(in srgb, ${statusColor(j.quoteStatus)} 45%, transparent)`,
                          }}
                        >
                          {j.quoteStatus ? (STATUS_LABEL[j.quoteStatus] ?? j.quoteStatus) : 'No quote'}
                        </span>
                        {hasDoc && (
                          <button
                            type="button"
                            className="linkbtn"
                            style={{ marginLeft: 8, fontSize: 11 }}
                            title="Open the printable quote"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate(`/quote/${j.quoteId}/print`)
                            }}
                          >
                            PDF
                          </button>
                        )}
                      </td>
                      <td className="r" style={{ fontFamily: 'var(--mono)' }}>
                        {j.total != null ? money(j.total) : '—'}
                      </td>
                      <td
                        className="r"
                        style={{
                          fontFamily: 'var(--mono)',
                          color: j.facts.balanceOwed > 0 ? 'var(--red)' : undefined,
                        }}
                      >
                        {j.facts.balanceOwed > 0 ? money(j.facts.balanceOwed) : '—'}
                      </td>
                      <td style={{ color: 'var(--txt-3)', fontSize: 11 }}>
                        {j.facts.neededBy ?? dateFmt(j.createdAt)}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {confirming === j.jobId ? (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ fontSize: 10, color: 'var(--red)' }}>
                              Delete {j.ref} and everything on it?
                            </span>
                            <button
                              type="button"
                              className="btn sm ghost"
                              onClick={() => setConfirming(null)}
                            >
                              Keep
                            </button>
                            <button
                              type="button"
                              className="btn sm danger"
                              disabled={busy}
                              onClick={() => void act(() => deleteProject(ctx.shop.id, j.jobId))}
                            >
                              Delete
                            </button>
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                            {!j.facts.takenInAt && (
                              <button
                                type="button"
                                className="btn sm"
                                disabled={busy}
                                title="Put it on the board at Intake."
                                onClick={() =>
                                  void act(() =>
                                    takeProjectIn(ctx.shop.id, j.jobId, ctx.profile.id),
                                  )
                                }
                              >
                                Take in
                              </button>
                            )}
                            <button
                              type="button"
                              className="linkbtn"
                              style={{ fontSize: 11, color: 'var(--red)' }}
                              onClick={() => setConfirming(j.jobId)}
                            >
                              delete
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
