/**
 * Starting a job nobody is paying for.
 *
 * Deliberately the shortest creation path in the program: a title, and
 * optionally a line about what you are trying to find out. There is no
 * client to pick, no quote to price, no delivery date to promise, because
 * none of those are true of a test print — and every field added here is a
 * reason not to bother logging the ten-minute experiment that, repeated
 * forty times, is where a shop's month actually went.
 *
 * That is the whole design risk with this feature. In-house work only tells
 * a shop anything if it is recorded consistently, and consistency dies at
 * the fourth required field. What the job cost gets recorded later, in the
 * same place client work does — runs and hours on the project itself.
 */
import { useEffect, useRef, useState } from 'react'
import { createInHouseJob } from '../lib/data'

const EXAMPLES = [
  'Calibrating the new PETG',
  'Bracket redesign, third attempt',
  'Sample parts for the Tuesday pitch',
  'Testing why the tall prints warp',
]

export default function InHouseDialog({
  open,
  shopId,
  onCancel,
  onCreated,
}: {
  open: boolean
  shopId: string
  onCancel: () => void
  onCreated: (jobId: string) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  // Reopening should be a blank form, not the last abandoned attempt.
  useEffect(() => {
    if (open) {
      setTitle('')
      setBrief('')
      setError(null)
    }
  }, [open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const id = await createInHouseJob(shopId, { title, brief })
      onCreated(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} onCancel={onCancel} aria-labelledby="ih-title">
      <form onSubmit={submit}>
        <div className="dlg-head">
          <b id="ih-title" style={{ fontSize: 14 }}>Start an in-house job</b>
        </div>

        <div className="dlg-body">
          <div className="fld">
            <label className="lbl" htmlFor="ih-name">What are you working on?</label>
            <input
              id="ih-name"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={EXAMPLES[0]}
            />
            <div className="hint">
              No client, no quote, no invoice. Log the runs and hours against it as you go and Guma
              counts what your own work costs you.
            </div>
          </div>

          <div className="fld" style={{ marginTop: 10 }}>
            <label className="lbl" htmlFor="ih-brief">What are you trying to find out? <span style={{ textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
            <textarea
              id="ih-brief"
              rows={2}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="So the version of you in three months knows why this exists."
            />
          </div>

          {error && (
            <div className="alert" style={{ marginBottom: 0 }}>
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="dlg-foot">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim() || busy}>
            {busy ? 'Starting…' : 'Start it'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
