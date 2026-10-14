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
import { useRef, useState } from 'react'
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
  onAdd,
  onChange,
  onClear,
}: {
  ctx: ShopContext
  lines: QuoteBuild[]
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

  async function pick(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setMsg(null)
    try {
      const parsed = await parseSliceFile(file)
      const kept = await packFile(new Uint8Array(await file.arrayBuffer()))
      const printer = matchPrinter(ctx.printerRows, parsed.printerModel)
      const material = matchMaterial(ctx.materials, parsed.totals.material)
      const key = `${Date.now()}-${file.name}`
      onAdd(
        buildsFromFile(parsed, key, printer?.id ?? (fallbackPrinterId || null), material?.id ?? (fallbackMaterialId || null)),
        { key, parsed, kept },
      )
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
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
      if (ref.current) ref.current.value = ''
    }
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
          void pick(e.dataTransfer.files?.[0])
        }}
      >
        <span className="drop-title">
          {busy ? 'Reading…' : lines.length ? 'Add another sliced file' : 'Price it from the sliced file'}
        </span>
        <span className="drop-sub">
          Drop or click · .gcode / .bgcode (PrusaSlicer) · .gcode.3mf / .3mf (Bambu, Orca) — fills
          in machine, material, grams and hours
        </span>
        <input
          id="q-slice"
          ref={ref}
          type="file"
          aria-label="Price from a sliced file"
          accept={SLICE_ACCEPT}
          disabled={busy}
          onChange={(e) => void pick(e.target.files?.[0])}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
        />
      </label>
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
