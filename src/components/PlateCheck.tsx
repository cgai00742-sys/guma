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
  /** The print that made this copy last, if one did. */
  runId: string | null
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
  /** For reprinted: the copies failed on this plate and printed again on
   *  another, with the print they failed on -- so the link can be undone. */
  replaced?: { copy: Copy; failedOn: string }[]
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
    const lastRun = copyRuns(p)
    const copy = (c: number): Copy => ({ part: p, copy: c, state: states[c - 1], runId: lastRun.get(c) ?? null })
    const mine = [...lastRun].filter(([c, r]) => r && runIds.has(r) && states[c - 1] && states[c - 1] !== 'pending').map(([c]) => copy(c))
    if (mine.length) {
      rows.push({ part: p, onPlate: n, copies: mine, kind: 'mine', where: null })
      continue
    }
    const others = [...lastRun].filter(([c, r]) => r && !runIds.has(r) && states[c - 1] && states[c - 1] !== 'pending')
    const failedHere = p.history.some((h) => h.runId && runIds.has(h.runId) && h.toStatus === 'reprint')
    if (others.length && failedHere) {
      const replaced = others.flatMap(([c]) => {
        const f = [...p.history].reverse().find((h) => h.toStatus === 'reprint' && h.runId && runIds.has(h.runId) && (h.copies ?? []).includes(c))
        return f ? [{ copy: copy(c), failedOn: f.runId! }] : []
      })
      rows.push({ part: p, onPlate: n, copies: [], kind: 'reprinted', where: describeRun(others[others.length - 1][1]!), replaced })
    } else if (others.length) {
      rows.push({ part: p, onPlate: n, copies: others.slice(0, n).map(([c]) => copy(c)), kind: 'elsewhere', where: describeRun(others[0][1]!) })
    } else {
      rows.push({ part: p, onPlate: n, copies: [], kind: 'none', where: null })
    }
  }
  return rows
}

/**
 * Which print each copy (1-based) belongs to now: the one that made it
 * LAST -- or, failed on a named print, that one (an undone replacement goes
 * back there).
 */
function copyRuns(p: PartRow): Map<number, string | null> {
  const lastRun = new Map<number, string | null>()
  for (const h of [...p.history].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id))
    if (h.kind === 'status' && (h.toStatus === 'printed' || (h.toStatus === 'reprint' && h.runId)))
      for (const c of h.copies ?? []) lastRun.set(c, h.runId ?? null)
  return lastRun
}

/**
 * The prints that could have replaced a failed copy (CG, 27 Nov: "when I
 * fail the first it asks if the later piece with the same file name was the
 * replacement"). A print counts when it came off clean after the copy's
 * own print, its plate holds this part, and it filled no copy of it -- an
 * extra print of the piece, which is what a reprint recorded before its
 * failure was known looks like (the 32" Anson cross-member: Oct 30, then
 * again Nov 9). Oldest first.
 */
export function replacementCandidates(c: Pick<Copy, 'part' | 'runId'>, runs: PrintRunRow[], slices: SliceImportRow[]): PrintRunRow[] {
  const own = c.runId ? runs.find((r) => r.id === c.runId) : null
  // A print some copy belongs to now is not a spare; one whose link was undone is again.
  const filled = new Set([...copyRuns(c.part).values()].filter((r): r is string => !!r))
  return runs
    .filter((r) => r.id !== c.runId && r.outcome === 'success' && !filled.has(r.id))
    .filter((r) => !own?.startedAt || !r.startedAt || r.startedAt >= own.startedAt)
    .filter((r) => slices.find((s) => s.id === r.sliceImportId)?.sections.some((sec) => sec.partId === c.part.id))
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
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
    // "2026-11-01 · PETG 31m": when, on what, and the file's sliced time.
    const time = f ? /(\d+h)?\d+m(?=\.[a-z0-9.]+$)/i.exec(f)?.[0] ?? null : null
    const what = [r.materialName, time].filter(Boolean).join(' ')
    return [r.startedAt?.slice(0, 10), what].filter(Boolean).join(' · ') || null
  }
  const rows = plateRows(sections, parts, runIds, describeRun)
  const [failing, setFailing] = useState<string | null>(null)
  const [why, setWhy] = useState('')
  const [fix, setFix] = useState('')
  const [fixedFile, setFixedFile] = useState<File | null>(null)
  /** For a failure with a later print of the piece: which print replaced it
   *  (its id), none yet (null), or not answered (undefined). Never guessed. */
  const [replaceWith, setReplaceWith] = useState<string | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!rows.length || (!canPass && !canFail)) return null

  const waiting = (r: PlateRow) => r.copies.filter((c) => c.state === 'printed')
  const allWaiting = rows.flatMap(waiting)

  /** Move copies, one call per part, one after another. */
  async function move(copies: Copy[], to: PartStatus, note: string | null, fixed: File | null = null, runId: string | null = null) {
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
        await setCopyStates(ctx.shop.id, partId, ctx.profile.id, cs.map((c) => c.copy - 1), to, note, runId)
      setFailing(null)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** Fail a copy on its own print, and -- when the person says a later
   *  print was its replacement -- mark it printed by that one, so each
   *  plate shows its own piece: "failed here, reprinted there" on the
   *  first, the replacement to check on the second. */
  async function failCopy(c: Copy, note: string, fixed: File | null, by: string | null) {
    if (!by) return move([c], 'reprint', note, fixed, c.runId)
    setSaving(true)
    setError(null)
    try {
      await setCopyStates(ctx.shop.id, c.part.id, ctx.profile.id, [c.copy - 1], 'reprint', note, c.runId)
      await setCopyStates(ctx.shop.id, c.part.id, ctx.profile.id, [c.copy - 1], 'printed', `Replaced by the ${describeRun(by) ?? 'later'} print.`, by)
      setFailing(null)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** Not its replacement after all: the copy goes back to the print it
   *  failed on, failed, as it was before the link. */
  async function unlink(c: Copy, failedOn: string) {
    setSaving(true)
    setError(null)
    try {
      const note = `Undid the link: the ${describeRun(c.runId ?? '') ?? 'later'} print was not its replacement.`
      await setCopyStates(ctx.shop.id, c.part.id, ctx.profile.id, [c.copy - 1], 'reprint', note, failedOn)
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const openFail = (key: string, preset: string | null | undefined = undefined) => {
    setFailing(failing === key ? null : key)
    setWhy('')
    setFix('')
    setFixedFile(null)
    setReplaceWith(preset)
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
      {/* One row per PIECE: two copies of a part on the plate are two
          rows, each passed or failed on its own (CG, 26 Nov: "in case one of
          them was good but the other not"). A decision can be undone. */}
      {rows.flatMap((r) => {
        const name = r.part.label.replace(/\.(stl|3mf|obj|step|stp)(?=\s*\(|$)/i, '')
        const note =
          r.kind === 'elsewhere'
            ? `also printed on ${r.where ?? 'another plate'}`
            : r.kind === 'reprinted'
              ? `failed here — reprinted on ${r.where ?? 'another plate'}, check it there`
              : r.kind === 'none'
                ? 'not marked printed'
                : ''
        if (!r.copies.length)
          return [
            <div key={r.part.id} className="objrow" data-testid={`piece-${name.toLowerCase()}`}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {name}
                <span className="pmeta" style={{ marginLeft: 8 }}>{note}</span>
              </span>
              {/* Linked to the wrong print: undo, back to failed here. Once
                  the replacement has been checked, undo that first. */}
              {(r.replaced ?? [])
                .filter((x) => x.copy.state === 'printed')
                .map((x) => (
                  <button
                    key={x.copy.copy}
                    type="button"
                    className="btn sm ghost"
                    disabled={off}
                    aria-label={`Undo the replacement of ${name}${(r.replaced ?? []).length > 1 ? ` copy ${x.copy.copy}` : ''}`}
                    title={`Not the replacement? Back to failed here, still to reprint.`}
                    onClick={() => void unlink(x.copy, x.failedOn)}
                  >
                    ↺ Undo
                  </button>
                ))}
            </div>,
          ]
        const many = r.copies.length > 1
        return r.copies.map((c) => {
          const key = `${r.part.id}:${c.copy}`
          const label = many ? `${name} · copy ${c.copy}` : name
          const testid = `piece-${name.toLowerCase()}${many ? `-${c.copy}` : ''}`
          const later = replacementCandidates(c, runs, slices)
          // On a plate that printed it again: this plate's own print, if it could be the replacement.
          const here = r.kind === 'elsewhere' ? later.find((x) => runIds.has(x.id)) ?? null : null
          const fromHere = failing === key && replaceWith != null && runIds.has(replaceWith)
          return (
            <div key={key}>
              <div className={`objrow ${c.state === 'reprint' ? 'failed' : ''}`.trim()} data-testid={testid}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {label}
                  <span className="pmeta" style={{ marginLeft: 8 }}>
                    {[
                      c.state === 'passed' ? '✓ passed' : c.state === 'reprint' ? '✕ failed — going back' : '',
                      note,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {c.state === 'printed' ? (
                  <span style={{ display: 'flex', gap: 6 }} role="group" aria-label={`Check ${label}`}>
                    {canPass && (
                      <button type="button" className="btn sm" style={PASS} disabled={off} onClick={() => void move([c], 'passed', null)}>
                        ✓ Pass
                      </button>
                    )}
                    {canFail && (
                      <button
                        type="button"
                        className="btn sm"
                        style={FAIL}
                        disabled={off}
                        onClick={() => openFail(key)}
                      >
                        ✕ Fail
                      </button>
                    )}
                    {/* Printed here again, but the copy is the earlier
                        print's: was this the reprint of a bad one? */}
                    {canFail && here && (
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={off}
                        title={`If the ${r.where ?? 'earlier'} piece was bad and this print replaced it`}
                        onClick={() => openFail(key, here.id)}
                      >
                        Replaced a bad one?
                      </button>
                    )}
                  </span>
                ) : c.state === 'passed' || c.state === 'reprint' ? (
                  // Marked the wrong one: back to "printed, not checked yet".
                  // A failed copy that has been reprinted is past undoing here.
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={off}
                    aria-label={`Undo ${c.state === 'passed' ? 'pass' : 'fail'} on ${label}`}
                    title="Marked the wrong one? Back to printed, not checked yet."
                    // Undone on the same print, so the copy stays on this plate.
                    onClick={() => void move([c], 'printed', `Undid the ${c.state === 'passed' ? 'pass' : 'fail'}: marked by mistake.`, null, c.runId)}
                  >
                    ↺ Undo
                  </button>
                ) : null}
              </div>
              {failing === key && (
                <div className="fld" style={{ margin: '4px 0 8px', padding: 8, background: 'var(--panel-3)', borderRadius: 6 }}>
                  {fromHere && (
                    <p className="hint" style={{ marginTop: 0 }}>
                      The {r.where ?? 'earlier'} piece failed, and this plate's print replaced it. Say what went wrong with the first one.
                    </p>
                  )}
                  {!fromHere && later.length > 0 && (
                    <>
                      <label className="lbl">Was a later print its replacement?</label>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }} role="group" aria-label="Was a later print its replacement?">
                        {later.map((x) => (
                          <button key={x.id} type="button" className={`chip ${replaceWith === x.id ? 'on' : ''}`} onClick={() => setReplaceWith(x.id)}>
                            Yes — the {describeRun(x.id) ?? 'later'} print
                          </button>
                        ))}
                        <button type="button" className={`chip ${replaceWith === null ? 'on' : ''}`} onClick={() => setReplaceWith(null)}>
                          No — print it again
                        </button>
                      </div>
                    </>
                  )}
                  <label className="lbl">What went wrong</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                    {REASONS.map((x) => (
                      <button key={x} type="button" className={`chip ${why === x ? 'on' : ''}`} onClick={() => setWhy(x)}>
                        {x}
                      </button>
                    ))}
                  </div>
                  <input value={why} placeholder="Or say it in your words" aria-label={`What went wrong with ${label}`} onChange={(e) => setWhy(e.target.value)} />
                  <label className="lbl" style={{ marginTop: 6 }}>How to get it right next time (optional)</label>
                  <input value={fix} placeholder="Brim on, slow first layer, dry the spool…" aria-label="How to get it right next time" onChange={(e) => setFix(e.target.value)} />
                  {!replaceWith && (
                    <>
                      <label className="lbl" style={{ marginTop: 6 }} htmlFor={`fixed-${key}`}>
                        Fixed file (optional) — the re-sliced plate for the reprint
                      </label>
                      <input id={`fixed-${key}`} type="file" accept={SLICE_ACCEPT} onChange={(e) => setFixedFile(e.target.files?.[0] ?? null)} />
                    </>
                  )}
                  <div className="btnrow" style={{ marginTop: 6, alignItems: 'center' }}>
                    <button
                      type="button"
                      className="btn sm"
                      style={FAIL}
                      disabled={off || !why.trim() || (later.length > 0 && replaceWith === undefined)}
                      onClick={() => void failCopy(c, reprintNote(why, fix, null), replaceWith ? null : fixedFile, replaceWith ?? null)}
                    >
                      {replaceWith ? 'Fail it — replaced' : 'Send it back'}
                    </button>
                    <button type="button" className="btn sm ghost" onClick={() => setFailing(null)}>
                      Cancel
                    </button>
                    <span className="hint" style={{ margin: 0 }}>
                      {replaceWith
                        ? `Failed on its own plate; the ${describeRun(replaceWith) ?? 'later'} print counts as this copy, to check on its plate.`
                        : later.length > 0 && replaceWith === undefined
                          ? 'Say whether a later print replaced it first.'
                          : 'It goes back on the list to print again, with this reason.'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )
        })
      })}
      {error && (
        <div className="attn crit" role="alert" style={{ marginTop: 6 }}>
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
