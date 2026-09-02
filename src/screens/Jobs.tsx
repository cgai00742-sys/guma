/**
 * Jobs list. The gap this closes: before this screen existed, saving a
 * quote (draft or sent) took it out of view permanently — there was no
 * page anywhere to see what had already been saved. This is the plain,
 * table-based version of that; the design package (design-package/design/
 * Pipeline Board.dc.html) already has a full drag-and-drop kanban board
 * across all seven job phases, fully styled, running on seed data — a
 * bigger, separate build (real per-job phase tracking, drag-to-move) that
 * this screen deliberately does not attempt. This is the minimum real page:
 * every saved job, newest first, click through to what was actually sent.
 *
 * A draft row has no rates_snapshot yet (see data.local.ts's
 * loadQuoteForPrint) — clicking into the print view for a draft is exactly
 * the blank-screen bug from before, so draft rows stay inert with a plain-
 * language reason rather than linking somewhere broken.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { makeMoney } from '../lib/pricing'
import { listJobs, toRateSet, type JobListRow, type ShopContext } from '../lib/data'

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

export default function Jobs({ ctx }: { ctx: ShopContext }) {
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

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <div className="section-head">
        <div>
          <h2>Jobs</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            {jobs ? `${jobs.length} saved` : 'Loading…'}
          </div>
        </div>
        <Link to="/intake" className="btn primary" style={{ textDecoration: 'none' }}>
          New job
        </Link>
      </div>

      {error && (
        <div className="alert">
          <span>{error}</span>
        </div>
      )}

      {!error && jobs && jobs.length === 0 && (
        <div className="pane" style={{ textAlign: 'center', color: 'var(--txt-3)', padding: '32px 16px' }}>
          Nothing saved yet. Every job you save from Job intake — draft or sent — shows up here.
        </div>
      )}

      {!error && jobs && jobs.length > 0 && (
        <div className="pane" style={{ padding: 0, overflow: 'hidden' }}>
          <table>
            <thead>
              <tr>
                <th>Ref</th>
                <th>Client</th>
                <th>Job</th>
                <th>Status</th>
                <th className="r">Total</th>
                <th>Saved</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const clickable = (j.quoteStatus === 'sent' || j.quoteStatus === 'accepted') && j.quoteId
                return (
                  <tr
                    key={j.jobId}
                    className={clickable ? 'row' : ''}
                    title={clickable ? undefined : 'Draft — reopen and re-save from Job intake to view a PDF.'}
                    onClick={clickable ? () => navigate(`/quote/${j.quoteId}/print`) : undefined}
                    style={clickable ? undefined : { cursor: 'default' }}
                  >
                    <td style={{ fontFamily: 'var(--mono)', color: 'var(--txt-3)' }}>{j.ref}</td>
                    <td>{j.clientName}</td>
                    <td>{j.title}</td>
                    <td>
                      <span className="chip" style={{ color: statusColor(j.quoteStatus), borderColor: 'color-mix(in srgb, ' + statusColor(j.quoteStatus) + ' 45%, transparent)' }}>
                        {j.quoteStatus ? STATUS_LABEL[j.quoteStatus] ?? j.quoteStatus : 'No quote'}
                      </span>
                    </td>
                    <td className="r" style={{ fontFamily: 'var(--mono)' }}>
                      {j.total != null ? money(j.total) : '—'}
                    </td>
                    <td style={{ color: 'var(--txt-3)' }}>{dateFmt(j.createdAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
