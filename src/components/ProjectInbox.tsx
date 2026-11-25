/**
 * The Print Inbox, from one project's page (CG, 24 Nov 2026).
 *
 * Two things: how many prints are waiting that Guma thinks belong here
 * (a link to them), and a way to send recorded prints BACK to the Inbox --
 * one put on the wrong project, one judged wrongly, or (the first RS850
 * sync) a whole batch recorded before anyone inspected them. Sending back
 * takes the pieces back out of assemblies and the Shelf, puts the
 * build-sheet copies back, removes the print, and leaves it waiting again
 * with its earlier answers as the starting point. The plate stays.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import * as data from '../lib/data'
import { listInbox } from '../lib/data'
import type { ProjectDetail, ShopContext } from '../lib/data.types'
import { sendBackToInbox } from '../lib/printInbox'

export function ProjectInbox({ ctx, detail, onChanged }: { ctx: ShopContext; detail: ProjectDetail; onChanged: () => Promise<void> }) {
  const [waiting, setWaiting] = useState(0)
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void listInbox(ctx.shop.id, 'new').then(
      (rows) => live && setWaiting(rows.filter((r) => (r.decision.jobId ?? r.suggestedJobId) === detail.jobId).length),
      () => {},
    )
    return () => {
      live = false
    }
  }, [ctx.shop.id, detail.jobId, detail.runs.length])

  const runs = [...detail.runs].filter((r) => r.sliceImportId).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
  const fileOf = (id: string | null) => detail.slices.find((s) => s.id === id)?.fileName ?? 'no plate'

  async function send() {
    setBusy(true)
    setError(null)
    try {
      await sendBackToInbox(ctx, data, detail.jobId, [...picked])
      setPicked(new Set())
      setOpen(false)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!waiting && !runs.length) return null
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
        {waiting > 0 && (
          <Link to={`/inbox?job=${detail.jobId}`} className="attn warn" style={{ textDecoration: 'none', padding: '4px 10px' }}>
            {waiting} print{waiting === 1 ? '' : 's'} waiting in the Print Inbox — say how {waiting === 1 ? 'it' : 'they'} came off →
          </Link>
        )}
        {runs.length > 0 && (
          <button type="button" className="linkbtn" style={{ width: 'auto', marginTop: 0, fontSize: 12 }} onClick={() => setOpen((x) => !x)}>
            {open ? 'Cancel' : 'Send prints back to the Inbox…'}
          </button>
        )}
      </div>
      {open && (
        <div className="pane" style={{ marginTop: 8 }} role="dialog" aria-label="Send prints back to the Inbox">
          <div style={{ fontSize: 12, color: 'var(--txt-2)', marginBottom: 6, maxWidth: 640 }}>
            Each print you tick comes off this project and waits in the Inbox again: what it made comes back out of
            assemblies and the Shelf, the build-sheet copies it marked go back, its material goes back on the shelf.
            Your earlier answers stay as the starting point. Use it for a print on the wrong project, or one judged
            before it was inspected. The plates stay here.
          </div>
          <label style={{ fontSize: 12, display: 'flex', gap: 6, marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={picked.size === runs.length}
              onChange={(e) => setPicked(e.target.checked ? new Set(runs.map((r) => r.id)) : new Set())}
            />
            <b>All {runs.length}</b>
          </label>
          {runs.map((r) => (
            <label key={r.id} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <input
                type="checkbox"
                checked={picked.has(r.id)}
                onChange={(e) =>
                  setPicked((p) => {
                    const n = new Set(p)
                    if (e.target.checked) n.add(r.id)
                    else n.delete(r.id)
                    return n
                  })
                }
              />
              <span>
                {r.startedAt?.slice(0, 10) ?? '—'} · {r.outcome === 'success' ? (r.failureReason ? 'some failed' : 'clean') : r.outcome === 'failed' ? 'failed' : 'stopped'} ·{' '}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fileOf(r.sliceImportId)}</span>
              </span>
            </label>
          ))}
          {error && (
            <div className="attn crit" role="alert" style={{ marginTop: 6 }}>
              <span>Nothing was sent back: {error}</span>
            </div>
          )}
          <div className="btnrow" style={{ marginTop: 8 }}>
            <button type="button" className="btn sm danger" disabled={busy || picked.size === 0} onClick={() => void send()}>
              {busy ? 'Sending back…' : `Send ${picked.size} back to the Inbox`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
