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
import type { JobKind, JobPhase, PartRow, PartStatus, PrintRunRow, ShopContext, SliceImportRow, SliceSectionRow } from '../lib/data.types'
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

/** One part on the plate, and the copies its pass or fail acts on. */
export interface PlateRow {
  part: PartRow
  /** How many of it the plate's file holds. */
  onPlate: number
  copies: Copy[]
  /**
   * mine: this plate's print made them.
   * elsewhere: another plate made the copies the build sheet counts -- this
   *   plate printed it again (CG, 25 Nov: the Nov 12 PETG plate reprinted the
   *   14 pieces of the Nov 1 plate, so its print marked nothing). Checking it
   *   here acts on the part's copies.
   * reprinted: failed here and printed again elsewhere: checked there.
   * none: nothing printed of it yet.
   */
  kind: 'mine' | 'elsewhere' | 'reprinted' | 'none'
  /** For elsewhere and reprinted: which print, in words. */
  where: string | null
}

/**
 * The plate's parts, from its file -- what was physically on the bed, one
 * row per part -- with the copies each row's Pass or Fail acts on.
 */
export function plateRows(
  sections: SliceSectionRow[],
  parts: PartRow[],
  runIds: Set<string>,
  describeRun: (runId: string) => string | null,
): PlateRow[] {
  const onPlate = new Map<string, number>()
  for (const sec of sections) if (sec.partId) onPlate.set(sec.partId, (onPlate.get(sec.partId) ?? 0) + Math.max(1, sec.qty || 1))
  const rows: PlateRow[] = []
  for (const [partId, n] of onPlate) {
    const p = parts.find((x) => x.id === partId)
    if (!p) continue
    const states = statesOf(p)
    // Each copy belongs to the print that made it LAST.
    const lastRun = new Map<number, string | null>()
    for (const h of [...p.history].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id))
      if (h.kind === 'status' && h.toStatus === 'printed') for (const c of h.copies ?? []) lastRun.set(c, h.runId ?? null)
    const copy = (c: number): Copy => ({ part: p, copy: c, state: states[c - 1] })
    const mine = [...lastRun].filter(([c, r]) => r && runIds.has(r) && states[c - 1] && states[c - 1] !== 'pending').map(([c]) => copy(c))
    if (mine.length) {
      rows.push({ part: p, onPlate: n, copies: mine, kind: 'mine', where: null })
      continue
    }
    const others = [...lastRun].filter(([c, r]) => r && !runIds.has(r) && states[c - 1] && states[c - 1] !== 'pending')
    const failedHere = p.history.some((h) => h.runId && runIds.has(h.runId) && h.toStatus === 'reprint')
    if (others.length && failedHere) {
      rows.push({ part: p, onPlate: n, copies: [], kind: 'reprinted', where: describeRun(others[others.length - 1][1]!) })
    } else if (others.length) {
      rows.push({ part: p, onPlate: n, copies: others.slice(0, n).map(([c]) => copy(c)), kind: 'elsewhere', where: describeRun(others[0][1]!) })
    } else {
      rows.push({ part: p, onPlate: n, copies: [], kind: 'none', where: null })
    }
  }
  return rows
}

const REASONS = ['Warping', 'Layer shift', 'Adhesion', 'Stringing', 'Surface finish', 'Wrong size', 'Broke in finishing']

const PASS = { background: 'var(--ok)', color: '#06140d', border: '1px solid var(--ok)', fontWeight: 600 } as const
const FAIL = { background: 'var(--red)', color: '#fff', border: '1px solid var(--red)', fontWeight: 600 } as const

export function PlateCheck({
  ctx,
  jobId,
  sections,
  parts,
  runIds,
  runs,
  slices,
  phase,
  kind,
  busy,
  onChanged,
}: {
  ctx: ShopContext
  jobId: string
  /** The plate's objects, from its file. */
  sections: SliceSectionRow[]
  parts: PartRow[]
  runIds: Set<string>
  /** Every print and plate on the project, to say where else a part printed. */
  runs: PrintRunRow[]
  slices: SliceImportRow[]
  phase: JobPhase
  kind: JobKind
  busy: boolean
  onChanged: () => Promise<void>
}) {
  const allowed = allowedStatuses(phase, kind)
  const canPass = allowed.includes('passed')
  const canFail = allowed.includes('reprint')
  const describeRun = (runId: string) => {
    const r = runs.find((x) => x.id === runId)
    if (!r) return null
    const f = slices.find((x) => x.id === r.sliceImportId)?.fileName
    const short = f ? f.replace(/\.(bgcode|gcode|3mf|gco|g)$/i, '').split('_').slice(-2).join(' ') : null
    return [r.startedAt?.slice(0, 10), short].filter(Boolean).join(' · ') || null
  }
  const rows = plateRows(sections, parts, runIds, describeRun)
  const [failing, setFailing] = useState<string | null>(null)
  const [n, setN] = useState(1)
  const [why, setWhy] = useState('')
  const [fix, setFix] = useState('')
  const [fixedFile, setFixedFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!rows.length || (!canPass && !canFail)) return null

  const waiting = (r: PlateRow) => r.copies.filter((c) => c.state === 'printed')
  const allWaiting = rows.flatMap(waiting)

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
  const passedN = rows.reduce((a, r) => a + r.copies.filter((c) => c.state === 'passed').length, 0)
  return (
    <div className="objresults" role="group" aria-label="Check the pieces" data-testid="plate-check" style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        <span className="lbl">
          Check the pieces — {rows.length} part{rows.length === 1 ? '' : 's'} on this plate
          {passedN ? ` · ${passedN} passed` : ''}
        </span>
        {canPass && allWaiting.length > 1 && (
          <button type="button" className="btn sm" style={PASS} disabled={off} onClick={() => void move(allWaiting, 'passed', null)}>
            ✓ Pass all {allWaiting.length}
          </button>
        )}
        {!canPass && <span className="hint" style={{ margin: 0 }}>Passing comes at Review; a bad piece can be failed now.</span>}
      </div>
      {rows.map((r) => {
        const w = waiting(r)
        const passed = r.copies.filter((c) => c.state === 'passed').length
        const back = r.copies.filter((c) => c.state === 'reprint').length
        const key = r.part.id
        const name = r.part.label.replace(/\.(stl|3mf|obj|step|stp)(?=\s*\(|$)/i, '')
        const note =
          r.kind === 'elsewhere'
            ? `also printed on ${r.where ?? 'another plate'}`
            : r.kind === 'reprinted'
              ? `failed here — reprinted on ${r.where ?? 'another plate'}, check it there`
              : r.kind === 'none'
                ? 'not marked printed'
                : ''
        return (
          <div key={key}>
            <div className={`objrow ${back && !w.length && !passed ? 'failed' : ''}`.trim()} data-testid={`piece-${name.toLowerCase()}`}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {name}
                {r.onPlate > 1 ? ` ×${r.onPlate}` : ''}
                <span className="pmeta" style={{ marginLeft: 8 }}>
                  {[
                    passed ? `✓ ${passed > 1 ? `${passed} ` : ''}passed` : '',
                    back ? `${back > 1 ? `${back} ` : ''}going back` : '',
                    w.length > 1 ? `${w.length} to check` : '',
                    note,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {w.length > 0 && (
                <span style={{ display: 'flex', gap: 6 }} role="group" aria-label={`Check ${name}`}>
                  {canPass && (
                    <button type="button" className="btn sm" style={PASS} disabled={off} onClick={() => void move(w, 'passed', null)}>
                      ✓ Pass{w.length > 1 ? ` ${w.length}` : ''}
                    </button>
                  )}
                  {canFail && (
                    <button
                      type="button"
                      className="btn sm"
                      style={FAIL}
                      disabled={off}
                      onClick={() => {
                        setFailing(failing === key ? null : key)
                        setN(1)
                        setWhy('')
                        setFix('')
                        setFixedFile(null)
                      }}
                    >
                      ✕ Fail
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
                  {REASONS.map((x) => (
                    <button key={x} type="button" className={`chip ${why === x ? 'on' : ''}`} onClick={() => setWhy(x)}>
                      {x}
                    </button>
                  ))}
                </div>
                <input value={why} placeholder="Or say it in your words" aria-label={`What went wrong with ${name}`} onChange={(e) => setWhy(e.target.value)} />
                <label className="lbl" style={{ marginTop: 6 }}>How to get it right next time (optional)</label>
                <input value={fix} placeholder="Brim on, slow first layer, dry the spool…" aria-label="How to get it right next time" onChange={(e) => setFix(e.target.value)} />
                <label className="lbl" style={{ marginTop: 6 }} htmlFor={`fixed-${key}`}>
                  Fixed file (optional) — the re-sliced plate for the reprint
                </label>
                <input id={`fixed-${key}`} type="file" accept={SLICE_ACCEPT} onChange={(e) => setFixedFile(e.target.files?.[0] ?? null)} />
                <div className="btnrow" style={{ marginTop: 6, alignItems: 'center' }}>
                  <button type="button" className="btn sm" style={FAIL} disabled={off || !why.trim()} onClick={() => void move(w.slice(0, n), 'reprint', reprintNote(why, fix, null), fixedFile)}>
                    {n > 1 ? `Send ${n} back` : 'Send it back'}
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setFailing(null)}>
                    Cancel
                  </button>
                  <span className="hint" style={{ margin: 0 }}>
                    It goes back on the list to print again, with this reason.
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
