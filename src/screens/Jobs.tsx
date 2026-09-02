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
import { Link, useNavigate } from 'react-router-dom'
import { makeMoney } from '../lib/pricing'
import { listJobs, toRateSet, type JobListRow, type ShopContext } from '../lib/data'
import { PHASE_LABEL, flagsFor, gateStatus, worstTone, type Flag } from '../lib/gates'

type SortKey = 'saved' | 'stage' | 'due' | 'value' | 'owed' | 'flags'

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
    return [...rows].sort(by[sort])
  }, [rows, sort])

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <div className="section-head">
        <div>
          <h2>Projects</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            {jobs
              ? `${jobs.length} saved · ${rows.filter((r) => r.flags.length > 0).length} flagged · ${money(rows.reduce((n, r) => n + r.facts.balanceOwed, 0))} owed`
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

      {!error && jobs && jobs.length === 0 && (
        <div className="pane" style={{ textAlign: 'center', color: 'var(--txt-3)', padding: '32px 16px' }}>
          Nothing saved yet. Every project you save from New project — draft or sent — shows up here.
        </div>
      )}

      {!error && jobs && jobs.length > 0 && (
        <>
          <div className="filters" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
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
                        <span className="chip">{PHASE_LABEL[j.phase]}</span>
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
