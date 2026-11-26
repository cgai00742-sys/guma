/**
 * Pass or fail what a plate made, on the plate (CG, 25 Nov 2026: "the
 * Pass/Fail section is a little redundant and could be better associated
 * with the plates that were actually printed ... it's just confusing to
 * match things up without a reference point").
 *
 * The plate is what came off the bed: its preview, its prints and the
 * camera's photo are right above. So the inspection is made here, on
 * exactly the copies this plate's prints made -- a part printed across two
 * plates is judged on each. Copies of one thing are one row ("7 × Gu'ut
 * lucha"), as the slicer's "(Instance n)" names are copies, not parts.
 *
 * Passing is a Review job; failing is open while building too, and sends
 * the copies back to be printed again with the reason, exactly as failing
 * on the parts list always has.
 */
import { useState } from 'react'
import { setCopyStates } from '../lib/data'
import type { JobKind, JobPhase, PartRow, PartStatus, ShopContext } from '../lib/data.types'
import { allowedStatuses, reprintNote } from '../lib/parts'
import { statesOf } from '../lib/copies'
import { importFixedFile } from '../lib/fixedFile'
import { SLICE_ACCEPT } from '../lib/sliceImport'

/** "Gu'ut lucha (Instance 3)", "Gu'ut lucha.stl" -> "Gu'ut lucha". */
export function pieceName(label: string): string {
  return label
    .trim()
    .replace(/\s*\((instance\s*)?\d+\)$/i, '')
    .replace(/\.(stl|3mf|obj|step|stp)$/i, '')
    .trim()
}

/** "7 × Gu'ut lucha, 7 × wedge pin" -- or the first few and how many more. */
export function piecesSummary(labels: { label: string; qty: number }[], max = 3): string {
  const by = new Map<string, number>()
  for (const l of labels) by.set(pieceName(l.label), (by.get(pieceName(l.label)) ?? 0) + l.qty)
  const all = [...by].map(([n, q]) => (q > 1 ? `${q} × ${n}` : n))
  return all.length > max + 1 ? `${all.slice(0, max).join(', ')} and ${all.length - max} more` : all.join(', ')
}

interface Copy {
  part: PartRow
  /** 1-based, as the history names copies. */
  copy: number
  state: PartStatus
}

interface Group {
  name: string
  copies: Copy[]
}

/** The copies this plate's prints made, by piece. */
export function plateCopies(parts: PartRow[], runIds: Set<string>): Group[] {
  const groups = new Map<string, Group>()
  for (const p of parts) {
    const states = statesOf(p)
    // Each copy belongs to the print that made it LAST: one failed here and
    // reprinted on another plate is checked there, not on both.
    const lastRun = new Map<number, string | null>()
    for (const h of [...p.history].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id))
      if (h.kind === 'status' && h.toStatus === 'printed') for (const c of h.copies ?? []) lastRun.set(c, h.runId ?? null)
    const mine = new Set<number>()
    for (const [c, run] of lastRun) if (run && runIds.has(run)) mine.add(c)
    for (const c of [...mine].sort((a, b) => a - b)) {
      const state = states[c - 1]
      if (!state || state === 'pending') continue
      const name = pieceName(p.label)
      const g = groups.get(name.toLowerCase()) ?? { name, copies: [] }
      g.copies.push({ part: p, copy: c, state })
      groups.set(name.toLowerCase(), g)
    }
  }
  return [...groups.values()]
}

const REASONS = ['Warping', 'Layer shift', 'Adhesion', 'Stringing', 'Surface finish', 'Wrong size', 'Broke in finishing']

export function PlateCheck({
  ctx,
  jobId,
  parts,
  runIds,
  phase,
  kind,
  busy,
  onChanged,
}: {
  ctx: ShopContext
  jobId: string
  parts: PartRow[]
  runIds: Set<string>
  phase: JobPhase
  kind: JobKind
  busy: boolean
  onChanged: () => Promise<void>
}) {
  const allowed = allowedStatuses(phase, kind)
  const canPass = allowed.includes('passed')
  const canFail = allowed.includes('reprint')
  const groups = plateCopies(parts, runIds)
  const [failing, setFailing] = useState<string | null>(null)
  const [n, setN] = useState(1)
  const [why, setWhy] = useState('')
  const [fix, setFix] = useState('')
  const [fixedFile, setFixedFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!groups.length || (!canPass && !canFail)) return null

  const waiting = (g: Group) => g.copies.filter((c) => c.state === 'printed')
  const allWaiting = groups.flatMap(waiting)

  /** Move copies, one call per part, one after another. */
  async function move(copies: Copy[], to: PartStatus, note: string | null, fixed: File | null = null) {
    setSaving(true)
    setError(null)
    try {
      // A fixed file goes on the part first, so the note can name it.
      if (fixed && copies.length) {
        const r = await importFixedFile(ctx, jobId, copies[0].part, fixed)
        note = `${note ?? ''} · Fixed file: ${r.name}`
      }
      const byPart = new Map<string, Copy[]>()
      for (const c of copies) byPart.set(c.part.id, [...(byPart.get(c.part.id) ?? []), c])
      for (const [partId, cs] of byPart)
        await setCopyStates(ctx.shop.id, partId, ctx.profile.id, cs.map((c) => c.copy - 1), to, note)
      setFailing(null)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const off = busy || saving
  return (
    <div className="objresults" role="group" aria-label="Check the pieces" data-testid="plate-check" style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
        <span className="lbl">Check the pieces</span>
        {canPass && allWaiting.length > 1 && (
          <button type="button" className="btn sm primary" disabled={off} onClick={() => void move(allWaiting, 'passed', null)}>
            Pass all {allWaiting.length}
          </button>
        )}
        {!canPass && <span className="hint" style={{ margin: 0 }}>Passing comes at Review; a bad piece can be failed now.</span>}
      </div>
      {groups.map((g) => {
        const w = waiting(g)
        const passed = g.copies.filter((c) => c.state === 'passed').length
        const back = g.copies.filter((c) => c.state === 'reprint').length
        const total = g.copies.length
        const key = g.name.toLowerCase()
        return (
          <div key={key}>
            <div className={`objrow ${back && !w.length && !passed ? 'failed' : ''}`.trim()} data-testid={`piece-${key}`}>
              <span style={{ flex: 1 }}>
                {total > 1 ? `${total} × ` : ''}
                {g.name}
                <span className="pmeta" style={{ marginLeft: 8 }}>
                  {[w.length ? `${w.length} to check` : '', passed ? `✓ ${passed} passed` : '', back ? `${back} going back` : ''].filter(Boolean).join(' · ')}
                </span>
              </span>
              {w.length > 0 && (
                <span className="seg" role="group" aria-label={`Check ${g.name}`}>
                  {canPass && (
                    <button type="button" className="segbtn printed" disabled={off} onClick={() => void move(w, 'passed', null)}>
                      ✓ Pass{w.length > 1 ? ` ${w.length}` : ''}
                    </button>
                  )}
                  {canFail && (
                    <button
                      type="button"
                      className="segbtn reprint"
                      disabled={off}
                      onClick={() => {
                        setFailing(failing === key ? null : key)
                        setN(1)
                        setWhy('')
                        setFix('')
                        setFixedFile(null)
                      }}
                    >
                      ✕ Fail…
                    </button>
                  )}
                </span>
              )}
            </div>
            {failing === key && (
              <div className="fld" style={{ margin: '4px 0 8px', padding: 8, background: 'var(--panel-3)', borderRadius: 6 }}>
                {w.length > 1 && (
                  <>
                    <label className="lbl">How many failed? (of {w.length})</label>
                    <input type="number" min={1} max={w.length} value={n} style={{ maxWidth: 100 }} onChange={(e) => setN(Math.min(w.length, Math.max(1, Math.floor(Number(e.target.value) || 1))))} />
                  </>
                )}
                <label className="lbl" style={{ marginTop: 6 }}>What went wrong</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  {REASONS.map((r) => (
                    <button key={r} type="button" className={`chip ${why === r ? 'on' : ''}`} onClick={() => setWhy(r)}>
                      {r}
                    </button>
                  ))}
                </div>
                <input value={why} placeholder="Or say it in your words" aria-label={`What went wrong with ${g.name}`} onChange={(e) => setWhy(e.target.value)} />
                <label className="lbl" style={{ marginTop: 6 }}>How to get it right next time (optional)</label>
                <input value={fix} placeholder="Brim on, slow first layer, dry the spool…" aria-label="How to get it right next time" onChange={(e) => setFix(e.target.value)} />
                <label className="lbl" style={{ marginTop: 6 }} htmlFor={`fixed-${key}`}>
                  Fixed file (optional) — the re-sliced plate for the reprint
                </label>
                <input id={`fixed-${key}`} type="file" accept={SLICE_ACCEPT} onChange={(e) => setFixedFile(e.target.files?.[0] ?? null)} />
                <div className="btnrow" style={{ marginTop: 6, alignItems: 'center' }}>
                  <button type="button" className="btn sm danger" disabled={off || !why.trim()} onClick={() => void move(w.slice(0, n), 'reprint', reprintNote(why, fix, null), fixedFile)}>
                    {n > 1 ? `Send ${n} back` : 'Send it back'}
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setFailing(null)}>
                    Cancel
                  </button>
                  <span className="hint" style={{ margin: 0 }}>
                    They go back on the build sheet to print again, with this reason.
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}
      {error && (
        <div className="attn crit" role="alert" style={{ marginTop: 6 }}>
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
