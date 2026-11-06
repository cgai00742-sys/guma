/**
 * Price a quote from the sliced files, on the New project form.
 *
 * CG: "have a way to upload the gcode files so it can automatically
 * implement for the project costs." Each file read here becomes quote build
 * lines -- one per object on the plate, on the machine and spool it was
 * sliced for -- and priceQuote prices every line at its own machine's rate.
 * Nothing is recorded as printed: this is a quote. When the project is
 * saved the files go onto it too (kept, and filling its build sheet), so
 * they are there to record from once the plates come off the bed.
 */
import { useEffect, useRef, useState } from 'react'
import HoursInput from './HoursInput'
import type { ShopContext } from '../lib/data'
import type { QuoteBuild } from '../lib/pricing'
import { buildsFromFile } from '../lib/quoteFromFile'
import { packFile, type KeptFile } from '../lib/sliceFile'
import {
  SLICE_ACCEPT,
  matchMaterial,
  matchPrinter,
  parseSliceFile,
  type SliceFile,
} from '../lib/sliceImport'
import {
  filesFromDrop,
  filesFromInput,
  isLitter,
  isSliced,
  planFolder,
  type FolderRow,
  type FoundFile,
} from '../lib/folderImport'

export interface QuoteFile {
  key: string
  parsed: SliceFile
  kept: KeptFile | null
}

const hrs = (m: number | null) =>
  m == null ? null : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`

export default function QuoteFiles({
  ctx,
  lines,
  fallbackPrinterId,
  fallbackMaterialId,
  files = [],
  onAdd,
  onChange,
  onClear,
}: {
  ctx: ShopContext
  lines: QuoteBuild[]
  /** The files already read onto this quote, so a folder does not add them twice. */
  files?: QuoteFile[]
  fallbackPrinterId: string
  fallbackMaterialId: string
  onAdd: (lines: QuoteBuild[], file: QuoteFile) => void
  onChange: (lines: QuoteBuild[]) => void
  onClear: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const ref = useRef<HTMLInputElement>(null)

  /** A folder (or several files) waiting on its checklist. */
  const [review, setReview] = useState<{ rows: FolderRow<KeptFile | null>[]; skipped: string[] } | null>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  // React has no prop for it; WebKit (the Mac app) and Chromium both honour it.
  useEffect(() => {
    folderRef.current?.setAttribute('webkitdirectory', '')
  }, [])

  function add(parsed: SliceFile, kept: KeptFile | null, key: string) {
    const printer = matchPrinter(ctx.printerRows, parsed.printerModel)
    const material = matchMaterial(ctx.materials, parsed.totals.material)
    onAdd(
      buildsFromFile(parsed, key, printer?.id ?? (fallbackPrinterId || null), material?.id ?? (fallbackMaterialId || null)),
      { key, parsed, kept },
    )
    return { printer, material }
  }

  async function pickOne(file: File) {
    const parsed = await parseSliceFile(file)
    const kept = await packFile(new Uint8Array(await file.arrayBuffer()))
    const { printer, material } = add(parsed, kept, `${Date.now()}-${file.name}`)
    const noNumbers = parsed.totals.estGrams == null && parsed.totals.estMinutes == null
    setMsg({
      ok: !noNumbers,
      text: noNumbers
        ? `${parsed.fileName}: no print time or filament in this file, so its lines are at zero. ${parsed.notes.join(' ')}`
        : `${parsed.fileName}: ${parsed.totals.sections} object${parsed.totals.sections === 1 ? '' : 's'}` +
          `${parsed.totals.estGrams != null ? `, ~${Math.round(parsed.totals.estGrams)} g` : ''}` +
          `${parsed.totals.estMinutes != null ? `, ~${hrs(parsed.totals.estMinutes)}` : ''}. ` +
          (printer
            ? `Priced on ${printer.name}.`
            : parsed.printerModel
              ? `The file says ${parsed.printerModel}, which isn't one of your machines — check the machine on each line.`
              : 'Check the machine on each line.') +
          (material ? '' : ' Check the material too.'),
    })
  }

  /**
   * One sliced file prices straight away, as it always has. A folder, or
   * more than one file, is read first and shown as a checklist.
   */
  async function pick(found: FoundFile[]) {
    const real = found.filter((f) => !isLitter(f.file.name))
    if (!real.length) return
    setBusy(true)
    setMsg(null)
    try {
      const sliced = real.filter((f) => isSliced(f.file.name))
      const skipped = real.filter((f) => !isSliced(f.file.name)).map((f) => f.path)
      if (real.length === 1) {
        await pickOne(real[0].file)
        return
      }
      if (!sliced.length) {
        setMsg({ ok: false, text: `No sliced files in that — ${skipped.length} other file${skipped.length === 1 ? '' : 's'} (.stl, images and so on). Slice them first, then add the .gcode, .bgcode or .3mf.` })
        return
      }
      const reads = []
      for (const [i, f] of sliced.entries()) {
        setProgress(`Reading ${i + 1} of ${sliced.length} · ${f.file.name}`)
        try {
          const parsed = await parseSliceFile(f.file)
          const kept = await packFile(new Uint8Array(await f.file.arrayBuffer()))
          reads.push({ key: `${Date.now()}-${i}-${f.file.name}`, path: f.path, parsed, error: null, extra: kept })
        } catch (e) {
          reads.push({ key: `${Date.now()}-${i}-${f.file.name}`, path: f.path, parsed: null, error: e instanceof Error ? e.message : String(e), extra: null })
        }
      }
      const already = files.map((x) => ({ fileName: x.parsed.fileName, estMinutes: x.parsed.totals.estMinutes, estGrams: x.parsed.totals.estGrams }))
      setReview({ rows: planFolder(reads, already), skipped })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
      setProgress(null)
      if (ref.current) ref.current.value = ''
      if (folderRef.current) folderRef.current.value = ''
    }
  }
  const [progress, setProgress] = useState<string | null>(null)

  function addReviewed() {
    if (!review) return
    const chosen = review.rows.filter((r) => r.include && r.parsed)
    let g = 0
    let m = 0
    for (const r of chosen) {
      add(r.parsed!, r.extra ?? null, r.key)
      g += r.parsed!.totals.estGrams ?? 0
      m += r.parsed!.totals.estMinutes ?? 0
    }
    setReview(null)
    setMsg({
      ok: true,
      text: `${chosen.length} file${chosen.length === 1 ? '' : 's'} added · ~${Math.round(g)} g · ~${hrs(Math.round(m))}. Check the machine and material on each line.`,
    })
  }

  const patch = (key: string, p: Partial<QuoteBuild>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...p } : l)))
  const num = (v: string) => {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : 0
  }
  const unitOf = (id: string | null) => ctx.materials.find((m) => m.id === id)?.unit ?? 'g'

  return (
    <div style={{ marginBottom: 12 }}>
      <label
        className={`drop ${dragging ? 'over' : ''}`}
        htmlFor="q-slice"
        style={{ padding: '12px 14px' }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void filesFromDrop(e.dataTransfer).then(pick)
        }}
      >
        <span className="drop-title">
          {busy ? (progress ?? 'Reading…') : lines.length ? 'Add more sliced files' : 'Price it from the sliced files'}
        </span>
        <span className="drop-sub">
          Drop files or a whole folder, or click · .gcode / .bgcode (PrusaSlicer) · .gcode.3mf / .3mf
          (Bambu, Orca) — fills in machine, material, grams and hours
        </span>
        <input
          id="q-slice"
          ref={ref}
          type="file"
          aria-label="Price from a sliced file, or several"
          accept={SLICE_ACCEPT}
          multiple
          disabled={busy}
          onChange={(e) => void pick(filesFromInput(e.target.files))}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
        />
      </label>
      <div style={{ marginTop: 6 }}>
        <button
          type="button"
          className="linkbtn"
          style={{ width: 'auto', marginTop: 0, fontSize: 12 }}
          disabled={busy}
          onClick={() => folderRef.current?.click()}
        >
          Choose a folder instead
        </button>
        <input
          ref={folderRef}
          type="file"
          aria-label="Price from a folder of sliced files"
          multiple
          disabled={busy}
          onChange={(e) => void pick(filesFromInput(e.target.files))}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
        />
      </div>
      {review && (
        <FolderChecklist
          review={review}
          ctx={ctx}
          onToggle={(key) =>
            setReview((r) => r && { ...r, rows: r.rows.map((x) => (x.key === key && x.parsed ? { ...x, include: !x.include } : x)) })
          }
          onAdd={addReviewed}
          onCancel={() => setReview(null)}
        />
      )}
      {msg && (
        <div
          className={msg.ok ? 'hint' : 'attn warn'}
          role={msg.ok ? 'status' : 'alert'}
          style={{ marginTop: 6, color: msg.ok ? 'var(--ok)' : undefined }}
        >
          <span>{msg.text}</span>
        </div>
      )}

      {lines.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="sheetwrap" style={{ maxHeight: 'none' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '24%' }}>Part</th>
                  <th className="r">Copies</th>
                  <th>Machine</th>
                  <th>Material</th>
                  <th className="r">Per copy</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td>
                      <span className="pn">{l.label}</span>
                    </td>
                    <td className="r">
                      <input
                        aria-label={`Copies of ${l.label}`}
                        type="number"
                        min="1"
                        value={l.qty}
                        style={{ width: 64 }}
                        onChange={(e) => patch(l.key, { qty: Math.max(1, Math.floor(num(e.target.value))) })}
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`Machine for ${l.label}`}
                        value={l.printerId ?? ''}
                        onChange={(e) => patch(l.key, { printerId: e.target.value || null })}
                      >
                        <option value="">Pick one</option>
                        {ctx.printers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Material for ${l.label}`}
                        value={l.materialId ?? ''}
                        onChange={(e) => patch(l.key, { materialId: e.target.value || null })}
                      >
                        <option value="">Pick one</option>
                        {ctx.materials.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      <input
                        aria-label={`${unitOf(l.materialId)} per copy of ${l.label}`}
                        type="number"
                        min="0"
                        step="0.1"
                        value={l.unitsPerPart}
                        style={{ width: 70 }}
                        onChange={(e) => patch(l.key, { unitsPerPart: num(e.target.value) })}
                      />{' '}
                      {unitOf(l.materialId)}{' '}
                      <HoursInput
                        compact
                        label={`Time per copy of ${l.label}`}
                        value={l.printHrsPerPart}
                        onChange={(h) => patch(l.key, { printHrsPerPart: h ?? 0 })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="linkbtn"
                        style={{ fontSize: 10 }}
                        aria-label={`Remove the line ${l.label}`}
                        onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            Copies start at what is on the plate. More copies scale the grams and hours per copy —
            close, but a full plate usually runs a little faster per piece than that. Each line is
            priced at its own machine&rsquo;s rate.{' '}
            <button type="button" className="linkbtn" style={{ width: 'auto' }} onClick={onClear}>
              Clear the lines and type it in by hand
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** What a folder held, before any of it is priced. */
function FolderChecklist({
  review,
  ctx,
  onToggle,
  onAdd,
  onCancel,
}: {
  review: { rows: FolderRow<KeptFile | null>[]; skipped: string[] }
  ctx: ShopContext
  onToggle: (key: string) => void
  onAdd: () => void
  onCancel: () => void
}) {
  const chosen = review.rows.filter((r) => r.include)
  const grams = chosen.reduce((a, r) => a + (r.parsed?.totals.estGrams ?? 0), 0)
  const mins = chosen.reduce((a, r) => a + (r.parsed?.totals.estMinutes ?? 0), 0)
  return (
    <div className="gatebox" role="group" aria-label="Files found" style={{ marginTop: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
        {review.rows.length} sliced file{review.rows.length === 1 ? '' : 's'} found — tick the plates this job prints
      </div>
      <div className="sheetwrap" style={{ maxHeight: 'none' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th>File</th>
              <th className="r">Objects</th>
              <th className="r">Filament</th>
              <th className="r">Time</th>
              <th>Machine</th>
            </tr>
          </thead>
          <tbody>
            {review.rows.map((r) => {
              const p = r.parsed
              const machine = p ? matchPrinter(ctx.printerRows, p.printerModel) : null
              return (
                <tr key={r.key} className={r.include ? undefined : 'dim'}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Include ${r.path}`}
                      checked={r.include}
                      disabled={!p}
                      onChange={() => onToggle(r.key)}
                    />
                  </td>
                  <td>
                    <span className="pn">{r.path}</span>
                    {r.note && <div className="hint" style={{ marginTop: 2 }}>{r.note}</div>}
                  </td>
                  <td className="r">{p?.totals.sections ?? '—'}</td>
                  <td className="r">{p?.totals.estGrams != null ? `${Math.round(p.totals.estGrams)} g` : '—'}</td>
                  <td className="r">{hrs(p?.totals.estMinutes ?? null) ?? '—'}</td>
                  <td>{machine?.name ?? p?.printerModel ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {review.skipped.length > 0 && (
        <div className="hint">
          {`Skipped ${review.skipped.length} file${review.skipped.length === 1 ? ' that is' : 's that are'} not sliced (${[
            ...new Set(review.skipped.map((x) => (x.match(/\.[^./]+$/)?.[0] ?? 'no extension').toLowerCase())),
          ].join(', ')}).`}
        </div>
      )}
      <div className="btnrow" style={{ marginTop: 8 }}>
        <button type="button" className="btn sm primary" disabled={!chosen.length} onClick={onAdd}>
          Add {chosen.length} file{chosen.length === 1 ? '' : 's'} to the quote
          {chosen.length ? ` · ~${Math.round(grams)} g · ~${hrs(Math.round(mins))}` : ''}
        </button>
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
