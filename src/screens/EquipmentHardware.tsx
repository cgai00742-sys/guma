/**
 * Equipment that is not a printer, and hardware counted per piece -- the two
 * Shop settings sections (CG, 27 Oct). See 0043_equipment_hardware.sql.
 *
 * Adding equipment ASKS how it is tracked, because a dryer "doesn't truly
 * sit with the number of printing hours": logged as it is used, riding
 * along with the printers it serves, or shop overhead. The type picked
 * fills in a starting power draw and life, each editable, each explained.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  addHardwareUse,
  archiveEquipment,
  archiveHardware,
  deleteEquipmentUse,
  deleteHardwareUse,
  listAssemblies,
  listEquipment,
  listHardware,
  listJobExtras,
  logEquipmentUse,
  saveEquipment,
  saveHardware,
  setAssemblyHardware,
  setPartHardware,
  type ShopContext,
} from '../lib/data'
import type {
  AssemblyRow,
  EquipmentInput,
  EquipmentKind,
  EquipmentRow,
  EquipmentTracking,
  EquipmentUseInput,
  HardwareInput,
  HardwareRow,
  HardwareUseInput,
  JobExtras,
  PartRow,
  ProjectDetail,
} from '../lib/data.types'
import HoursInput from '../components/HoursInput'
import { fmtHours } from '../lib/duration'
import { EQUIPMENT_KINDS, TRACKING_LABEL, equipmentHourly, hardwarePrice, suggestionFor } from '../lib/equipment'
import { makeMoney } from '../lib/pricing'
import { Flash, useFlash } from '../components/Saving'

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v))

export function EquipmentPane({ ctx }: { ctx: ShopContext }) {
  const [rows, setRows] = useState<EquipmentRow[] | null>(null)
  const [editing, setEditing] = useState<EquipmentRow | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useFlash()
  const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)
  const kwh = ctx.shop.electricity_rate_kwh == null ? null : Number(ctx.shop.electricity_rate_kwh)

  const reload = useCallback(async () => {
    try {
      setRows(await listEquipment(ctx.shop.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [ctx.shop.id])
  useEffect(() => {
    void reload()
  }, [reload])

  async function save(input: EquipmentInput) {
    setError(null)
    try {
      await saveEquipment(ctx.shop.id, input)
      setEditing(null)
      await reload()
      setFlash(`${input.name.trim()} saved.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const live = (rows ?? []).filter((r) => !r.archived)
  const retired = (rows ?? []).filter((r) => r.archived)
  const printerName = (id: string) => ctx.printerRows.find((p) => p.id === id)?.name ?? 'a removed printer'

  return (
    <section className="pane" aria-label="Other equipment" style={{ marginTop: 16 }}>
      <h3>Other equipment</h3>
      <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
        Machines that are not printers — a filament dryer, a wash &amp; cure station, a fume extractor. Each costs power and wear
        by the hour; you choose how its hours are counted.
        {kwh == null && ' Set your electricity rate under Costs, or power counts as nothing.'}
      </div>
      <Flash message={flash} />
      {error && (
        <div className="alert" style={{ marginBottom: 8 }}>
          <span>{error}</span>
        </div>
      )}
      {live.length > 0 && (
        <div className="stack">
          {live.map((r) => {
            const h = equipmentHourly(r, kwh)
            return editing !== 'new' && editing?.id === r.id ? (
              <EquipmentForm key={r.id} ctx={ctx} start={r} onCancel={() => setEditing(null)} onSave={save} />
            ) : (
              <div key={r.id} className="eqrow">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{r.name}</b>
                  <span className="pmeta" style={{ marginLeft: 8 }}>{suggestionFor(r.kind).label}</span>
                  <div className="pmeta">
                    {TRACKING_LABEL[r.tracking].label}
                    {r.tracking === 'printers' &&
                      ` — ${r.printerIds.length ? r.printerIds.map(printerName).join(', ') : 'no printers picked yet'}`}
                    {' · '}
                    {r.watts != null ? `${r.watts} W` : 'no power set'} ·{' '}
                    {h.total > 0 ? `${money(h.total)} an hour` : 'nothing an hour yet'}
                  </div>
                </div>
                <button type="button" className="btn sm" onClick={() => setEditing(r)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="linkbtn"
                  style={{ width: 'auto', fontSize: 11 }}
                  onClick={() => void archiveEquipment(ctx.shop.id, r.id, true).then(reload)}
                >
                  retire
                </button>
              </div>
            )
          })}
        </div>
      )}
      {rows && live.length === 0 && editing !== 'new' && <div className="hint">None yet.</div>}
      {editing === 'new' ? (
        <EquipmentForm ctx={ctx} start={null} onCancel={() => setEditing(null)} onSave={save} />
      ) : (
        <button type="button" className="btn sm primary" style={{ marginTop: 10 }} onClick={() => setEditing('new')}>
          Add equipment
        </button>
      )}
      {retired.length > 0 && (
        <div className="pmeta" style={{ marginTop: 10 }}>
          Retired:{' '}
          {retired.map((r) => (
            <button
              key={r.id}
              type="button"
              className="linkbtn"
              style={{ width: 'auto', fontSize: 11, marginRight: 8 }}
              onClick={() => void archiveEquipment(ctx.shop.id, r.id, false).then(reload)}
            >
              {r.name} (bring back)
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function EquipmentForm({
  ctx,
  start,
  onCancel,
  onSave,
}: {
  ctx: ShopContext
  start: EquipmentRow | null
  onCancel: () => void
  onSave: (input: EquipmentInput) => void
}) {
  const first = suggestionFor(start?.kind ?? 'dryer')
  const [kind, setKind] = useState<EquipmentKind>(start?.kind ?? 'dryer')
  const [name, setName] = useState(start?.name ?? '')
  const [tracking, setTracking] = useState<EquipmentTracking>(start?.tracking ?? first.tracking)
  const [watts, setWatts] = useState(String(start ? start.watts ?? '' : first.watts ?? ''))
  const [price, setPrice] = useState(String(start?.price ?? ''))
  const [life, setLife] = useState(String(start ? start.lifeHours ?? '' : first.lifeHours ?? ''))
  const [printers, setPrinters] = useState<string[]>(start?.printerIds ?? [])
  const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)
  const kwh = ctx.shop.electricity_rate_kwh == null ? null : Number(ctx.shop.electricity_rate_kwh)
  const s = suggestionFor(kind)
  const h = equipmentHourly({ watts: num(watts), price: num(price), lifeHours: num(life) }, kwh)
  const id = start?.id ?? 'new'

  function pickKind(k: EquipmentKind) {
    setKind(k)
    // A new one takes the type's starting point; an existing one keeps the
    // numbers somebody already set.
    if (!start) {
      const n = suggestionFor(k)
      setTracking(n.tracking)
      setWatts(n.watts == null ? '' : String(n.watts))
      setLife(n.lifeHours == null ? '' : String(n.lifeHours))
    }
  }

  return (
    <div className="pane" style={{ margin: '10px 0 0' }} role="group" aria-label={start ? `Edit ${start.name}` : 'New equipment'}>
      <div className="grid3">
        <div className="fld">
          <label className="lbl" htmlFor={`eq-kind-${id}`}>What it is</label>
          <select id={`eq-kind-${id}`} value={kind} onChange={(e) => pickKind(e.target.value as EquipmentKind)}>
            {EQUIPMENT_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`eq-name-${id}`}>Name</label>
          <input id={`eq-name-${id}`} value={name} placeholder={kind === 'dryer' ? 'Sunlu S4 Pro' : ''} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`eq-price-${id}`}>What it cost</label>
          <input id={`eq-price-${id}`} type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`eq-watts-${id}`}>Average power (W)</label>
          <input id={`eq-watts-${id}`} type="number" min="0" step="any" value={watts} onChange={(e) => setWatts(e.target.value)} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`eq-life-${id}`}>Expected life (hours)</label>
          <input id={`eq-life-${id}`} type="number" min="1" step="any" value={life} onChange={(e) => setLife(e.target.value)} />
        </div>
      </div>
      {s.why && <div className="hint" style={{ marginTop: 4 }}>{s.why}</div>}

      <div className="fld" style={{ marginTop: 10 }} role="radiogroup" aria-label="How to track it">
        <div className="lbl">How should its hours be counted?</div>
        <div className="trackpick">
          {(Object.keys(TRACKING_LABEL) as EquipmentTracking[]).map((t) => (
            <label key={t} className={`trackopt ${tracking === t ? 'on' : ''}`}>
              <input type="radio" name={`eq-track-${id}`} checked={tracking === t} onChange={() => setTracking(t)} />
              <span>
                <b>{TRACKING_LABEL[t].label}</b>
                <span className="pmeta" style={{ display: 'block' }}>{TRACKING_LABEL[t].sub}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      {tracking === 'printers' && (
        <div className="fld" style={{ marginTop: 8 }} role="group" aria-label="Printers it serves">
          <div className="lbl">Which printers does it serve?</div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, marginTop: 4 }}>
            {ctx.printerRows
              .filter((p) => !Number(p.archived))
              .map((p) => (
                <label key={p.id} className="pickline">
                  <input
                    type="checkbox"
                    checked={printers.includes(p.id)}
                    onChange={(e) => setPrinters((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
                  />
                  {p.name}
                </label>
              ))}
          </div>
          <div className="hint">If two of them print at the same time it is counted for both — set its power as what it draws per printer.</div>
        </div>
      )}
      <div className="hint" style={{ marginTop: 8 }}>
        An hour of it costs <b>{money(h.total)}</b>
        {h.total > 0 ? ` — ${money(h.power)} power${kwh == null ? '' : ` at ${money(kwh)}/kWh`}, ${money(h.wear)} wear` : ''}.
      </div>
      <div className="btnrow" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn sm primary"
          disabled={!name.trim() || (tracking === 'printers' && printers.length === 0)}
          onClick={() => onSave({ id: start?.id, name, kind, tracking, watts: num(watts), price: num(price), lifeHours: num(life), printerIds: printers })}
        >
          {tracking === 'printers' && printers.length === 0 ? 'Pick at least one printer' : 'Save'}
        </button>
        <button type="button" className="btn sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function HardwarePane({ ctx }: { ctx: ShopContext }) {
  const [rows, setRows] = useState<HardwareRow[] | null>(null)
  const [editing, setEditing] = useState<HardwareRow | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useFlash()
  const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)

  const reload = useCallback(async () => {
    try {
      setRows(await listHardware(ctx.shop.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [ctx.shop.id])
  useEffect(() => {
    void reload()
  }, [reload])

  async function save(input: HardwareInput) {
    setError(null)
    try {
      await saveHardware(ctx.shop.id, input)
      setEditing(null)
      await reload()
      setFlash(`${input.name.trim()} saved.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const live = (rows ?? []).filter((r) => !r.archived)
  return (
    <section className="pane" aria-label="Hardware" style={{ marginTop: 16 }}>
      <h3>Hardware</h3>
      <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
        Pieces counted one by one — magnets, heat-set inserts, dowels. Set how many a part's copy or an assembly uses and they come
        off this count as the work is done.
      </div>
      <Flash message={flash} />
      {error && (
        <div className="alert" style={{ marginBottom: 8 }}>
          <span>{error}</span>
        </div>
      )}
      {live.length > 0 && (
        <div className="stack">
          {live.map((r) =>
            editing !== 'new' && editing?.id === r.id ? (
              <HardwareForm key={r.id} start={r} money={money} onCancel={() => setEditing(null)} onSave={save} />
            ) : (
              <div key={r.id} className={`eqrow ${r.available <= r.reorderAt ? 'low' : ''}`}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{r.name}</b>
                  <div className="pmeta">
                    {money(r.unitCost)} each
                    {r.markupPct > 0 ? ` · ${r.markupPct}% markup → ${money(hardwarePrice(r.unitCost, r.markupPct))} to a client` : ''}
                  </div>
                </div>
                <span className={`hwcount ${r.available <= r.reorderAt ? 'low' : ''}`} title={`${r.used} used so far`}>
                  {Math.round(r.available * 100) / 100} on hand
                  {r.available <= r.reorderAt ? ' — reorder' : ''}
                </span>
                <button type="button" className="btn sm" onClick={() => setEditing(r)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="linkbtn"
                  style={{ width: 'auto', fontSize: 11 }}
                  onClick={() => void archiveHardware(ctx.shop.id, r.id, true).then(reload)}
                >
                  retire
                </button>
              </div>
            ),
          )}
        </div>
      )}
      {rows && live.length === 0 && editing !== 'new' && <div className="hint">None yet.</div>}
      {editing === 'new' ? (
        <HardwareForm start={null} money={money} onCancel={() => setEditing(null)} onSave={save} />
      ) : (
        <button type="button" className="btn sm primary" style={{ marginTop: 10 }} onClick={() => setEditing('new')}>
          Add hardware
        </button>
      )}
    </section>
  )
}

function HardwareForm({
  start,
  money,
  onCancel,
  onSave,
}: {
  start: HardwareRow | null
  money: (n: number) => string
  onCancel: () => void
  onSave: (input: HardwareInput) => void
}) {
  const [name, setName] = useState(start?.name ?? '')
  const [onHand, setOnHand] = useState(start ? String(Math.round(start.available * 100) / 100) : '')
  const [cost, setCost] = useState(start ? String(start.unitCost) : '')
  const [markup, setMarkup] = useState(start ? String(start.markupPct) : '0')
  const [reorder, setReorder] = useState(start ? String(start.reorderAt) : '0')
  const id = start?.id ?? 'new'
  const c = Number(cost) || 0
  const m = Number(markup) || 0
  return (
    <div className="pane" style={{ margin: '10px 0 0' }} role="group" aria-label={start ? `Edit ${start.name}` : 'New hardware'}>
      <div className="grid3">
        <div className="fld">
          <label className="lbl" htmlFor={`hw-name-${id}`}>What it is</label>
          <input id={`hw-name-${id}`} value={name} placeholder="6×2 mm magnet" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`hw-onhand-${id}`}>How many on hand</label>
          <input id={`hw-onhand-${id}`} type="number" min="0" step="1" value={onHand} onChange={(e) => setOnHand(e.target.value)} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`hw-cost-${id}`}>Cost per unit</label>
          <input id={`hw-cost-${id}`} type="number" min="0" step="any" value={cost} onChange={(e) => setCost(e.target.value)} />
          <div className="hint">A pack of 100 for $8 is 0.08.</div>
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`hw-markup-${id}`}>Markup % (if any)</label>
          <input id={`hw-markup-${id}`} type="number" min="0" step="any" value={markup} onChange={(e) => setMarkup(e.target.value)} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`hw-reorder-${id}`}>Reorder when down to</label>
          <input id={`hw-reorder-${id}`} type="number" min="0" step="1" value={reorder} onChange={(e) => setReorder(e.target.value)} />
        </div>
      </div>
      {c > 0 && (
        <div className="hint" style={{ marginTop: 4 }}>
          Costs you {money(c)} each{m > 0 ? `; a client pays ${money(hardwarePrice(c, m))}` : ''}.
        </div>
      )}
      <div className="btnrow" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn sm primary"
          disabled={!name.trim() || cost.trim() === ''}
          onClick={() =>
            onSave({ id: start?.id, name, onHand: Number(onHand) || 0, unitCost: c, markupPct: m, reorderAt: Number(reorder) || 0 })
          }
        >
          Save
        </button>
        <button type="button" className="btn sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * On a project, inside "What it actually took": equipment hours and
 * hardware pieces (CG, 27 Oct). Equipment tracked by hours is logged here;
 * equipment riding along with printers is shown, worked out from the prints
 * above; hardware is set per part (client work) or per assembly (in-house),
 * or logged by hand.
 */
export function ProjectExtras({
  ctx,
  detail,
  busy,
  readOnly = false,
  onChanged,
  setError,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  busy: boolean
  readOnly?: boolean
  onChanged: () => Promise<void>
  setError: (m: string | null) => void
}) {
  const [extras, setExtras] = useState<JobExtras | null>(null)
  const [equipment, setEquipment] = useState<EquipmentRow[]>([])
  const [hardware, setHardware] = useState<HardwareRow[]>([])
  const [assemblies, setAssemblies] = useState<AssemblyRow[]>([])
  const [saving, setSaving] = useState(false)
  const { money } = makeMoney(ctx.shop.currency, ctx.shop.locale)
  const kwh = ctx.shop.electricity_rate_kwh == null ? null : Number(ctx.shop.electricity_rate_kwh)
  const mine = detail.facts.kind === 'inhouse'

  const load = useCallback(async () => {
    try {
      const [x, e, h, a] = await Promise.all([
        listJobExtras(ctx.shop.id, detail.jobId),
        listEquipment(ctx.shop.id),
        listHardware(ctx.shop.id),
        mine ? listAssemblies(ctx.shop.id, detail.jobId) : Promise.resolve([] as AssemblyRow[]),
      ])
      setExtras(x)
      setEquipment(e)
      setHardware(h)
      setAssemblies(a)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [ctx.shop.id, detail.jobId, mine, setError])
  // The project reloads after every change on it; follow it, so a copy
  // printed above shows its pieces here at once.
  useEffect(() => {
    void load()
  }, [load, detail])

  async function act(fn: () => Promise<unknown>) {
    setSaving(true)
    setError(null)
    try {
      await fn()
      await onChanged()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!extras) return null
  const logged = equipment.filter((e) => e.tracking === 'hours' && !e.archived)
  const riding = equipment.filter((e) => e.tracking === 'printers')
  const items = hardware.filter((h) => !h.archived)
  const itemName = (id: string) => hardware.find((h) => h.id === id)?.name ?? 'removed hardware'
  const itemCost = (id: string) => hardware.find((h) => h.id === id)?.unitCost ?? 0
  const hourly = (id: string) => {
    const e = equipment.find((x) => x.id === id)
    return e ? equipmentHourly(e, kwh).total : 0
  }
  const rides = riding
    .map((e) => {
      const hours = detail.runs.filter((r) => r.printerId && e.printerIds.includes(r.printerId)).reduce((t, r) => t + (r.hours ?? 0), 0)
      return { e, hours, cost: hours * equipmentHourly(e, kwh).total }
    })
    .filter((x) => x.hours > 0)
  const done = (p: PartRow) => p.printedN + p.passedN + p.spareN
  const partLines = extras.partHardware.flatMap((l) => {
    const p = detail.parts.find((x) => x.id === l.partId)
    return p ? [{ ...l, part: p, used: l.perCopy * done(p) }] : []
  })
  const nothing =
    logged.length === 0 && rides.length === 0 && items.length === 0 && extras.equipment.length === 0 && extras.hardware.length === 0
  if (nothing)
    return (
      <div className="hint" style={{ marginTop: 12 }}>
        Other equipment (a filament dryer) and hardware (magnets, inserts) are added in Shop settings — Machines and Materials —
        and then show up here.
      </div>
    )

  return (
    <div className="extras" role="region" aria-label="Equipment and hardware">
      <div className="sechead" style={{ marginTop: 14 }}>
        <h4>Equipment &amp; hardware</h4>
        <span className="sub">Counted in what this project cost.</span>
      </div>

      {(logged.length > 0 || extras.equipment.length > 0 || rides.length > 0) && (
        <div className="extras-block">
          <div className="lbl">Equipment</div>
          {rides.map(({ e, hours, cost }) => (
            <div key={e.id} className="histitem">
              <span>
                {e.name} <span className="pmeta">— alongside the prints, {fmtHours(hours)}</span>
              </span>
              <span className="pmeta" style={{ marginLeft: 'auto' }}>{money(cost)}</span>
            </div>
          ))}
          {extras.equipment.map((u) => (
            <div key={u.id} className="histitem">
              <span>
                {u.equipmentName} <span className="pmeta">— {fmtHours(u.hours)}{u.usedOn ? ` on ${u.usedOn}` : ''}{u.note ? ` · ${u.note}` : ''}</span>
              </span>
              <span className="pmeta" style={{ marginLeft: 'auto' }}>{money(u.hours * hourly(u.equipmentId))}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="linkbtn"
                  style={{ width: 'auto', fontSize: 11, marginTop: 0 }}
                  disabled={busy || saving}
                  aria-label={`Remove ${u.equipmentName} ${fmtHours(u.hours)}`}
                  onClick={() => void act(() => deleteEquipmentUse(ctx.shop.id, u.id))}
                >
                  remove
                </button>
              )}
            </div>
          ))}
          {!readOnly && logged.length > 0 && (
            <LogEquipment equipment={logged} busy={busy || saving} onLog={(input) => act(() => logEquipmentUse(ctx.shop.id, detail.jobId, ctx.profile.id, input))} />
          )}
        </div>
      )}

      {(items.length > 0 || extras.hardware.length > 0) && (
        <div className="extras-block">
          <div className="lbl">Hardware</div>
          {partLines.map((l) => (
            <div key={`${l.partId}:${l.itemId}`} className="histitem">
              <span>
                {l.part.label}: {l.perCopy} × {itemName(l.itemId)} a copy
                <span className="pmeta"> — {done(l.part)} cop{done(l.part) === 1 ? 'y' : 'ies'} off, {l.used} used</span>
              </span>
              <span className="pmeta" style={{ marginLeft: 'auto' }}>{money(l.used * itemCost(l.itemId))}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="linkbtn"
                  style={{ width: 'auto', fontSize: 11, marginTop: 0 }}
                  disabled={busy || saving}
                  onClick={() => void act(() => setPartHardware(ctx.shop.id, l.partId, l.itemId, 0))}
                >
                  remove
                </button>
              )}
            </div>
          ))}
          {extras.assemblyHardware.map((l) => {
            const a = assemblies.find((x) => x.id === l.assemblyId)
            if (!a || a.status === 'done') return null
            return (
              <div key={`${l.assemblyId}:${l.itemId}`} className="histitem">
                <span>
                  {a.name}: {l.perUnit} × {itemName(l.itemId)}
                  <span className="pmeta"> — used when it is finished</span>
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    className="linkbtn"
                    style={{ width: 'auto', fontSize: 11, marginTop: 0, marginLeft: 'auto' }}
                    disabled={busy || saving}
                    onClick={() => void act(() => setAssemblyHardware(ctx.shop.id, l.assemblyId, l.itemId, 0))}
                  >
                    remove
                  </button>
                )}
              </div>
            )
          })}
          {extras.hardware.map((u) => (
            <div key={u.id} className="histitem">
              <span>
                {u.qty} × {u.itemName}
                <span className="pmeta"> — {u.source === 'assembly' ? u.note ?? 'in an assembly' : u.note ?? 'logged'}</span>
              </span>
              <span className="pmeta" style={{ marginLeft: 'auto' }}>{money(u.qty * u.unitCost)}</span>
              {!readOnly && u.source === 'manual' && (
                <button
                  type="button"
                  className="linkbtn"
                  style={{ width: 'auto', fontSize: 11, marginTop: 0 }}
                  disabled={busy || saving}
                  aria-label={`Remove ${u.qty} × ${u.itemName}`}
                  onClick={() => void act(() => deleteHardwareUse(ctx.shop.id, u.id))}
                >
                  remove
                </button>
              )}
            </div>
          ))}
          {!readOnly && items.length > 0 && (
            <HardwareAdders
              items={items}
              parts={mine ? [] : detail.parts}
              assemblies={assemblies.filter((a) => a.status === 'open')}
              busy={busy || saving}
              onPer={(target, itemId, n) =>
                act(() =>
                  target.kind === 'part'
                    ? setPartHardware(ctx.shop.id, target.id, itemId, n)
                    : setAssemblyHardware(ctx.shop.id, target.id, itemId, n),
                )
              }
              onLog={(input) => act(() => addHardwareUse(ctx.shop.id, detail.jobId, ctx.profile.id, input))}
            />
          )}
        </div>
      )}
    </div>
  )
}

function LogEquipment({
  equipment,
  busy,
  onLog,
}: {
  equipment: EquipmentRow[]
  busy: boolean
  onLog: (input: EquipmentUseInput) => Promise<void>
}) {
  const [eq, setEq] = useState(equipment[0]?.id ?? '')
  const [hours, setHours] = useState<number | null>(null)
  const [on, setOn] = useState('')
  const [note, setNote] = useState('')
  return (
    <div className="btnrow" style={{ marginTop: 8, alignItems: 'flex-end' }} role="group" aria-label="Log equipment hours">
      <div className="fld" style={{ margin: 0, minWidth: 170 }}>
        <label className="lbl" htmlFor="ex-eq">Equipment</label>
        <select id="ex-eq" value={eq} onChange={(e) => setEq(e.target.value)}>
          {equipment.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>
      <div className="fld" style={{ margin: 0 }}>
        <label className="lbl" htmlFor="ex-eq-h">How long</label>
        <HoursInput id="ex-eq-h" label="How long" value={hours} onChange={setHours} compact />
      </div>
      <div className="fld" style={{ margin: 0 }}>
        <label className="lbl" htmlFor="ex-eq-on">When</label>
        <input id="ex-eq-on" type="date" value={on} onChange={(e) => setOn(e.target.value)} style={{ width: 150 }} />
      </div>
      <div className="fld" style={{ margin: 0, flex: 1, minWidth: 140 }}>
        <label className="lbl" htmlFor="ex-eq-note">Note</label>
        <input id="ex-eq-note" value={note} placeholder="PETG before printing" onChange={(e) => setNote(e.target.value)} />
      </div>
      <button
        type="button"
        className="btn sm primary"
        disabled={busy || !eq || !(hours && hours > 0)}
        onClick={() =>
          void onLog({ equipmentId: eq, hours: hours ?? 0, usedOn: on || null, note: note || null }).then(() => {
            setHours(null)
            setNote('')
          })
        }
      >
        Log it
      </button>
    </div>
  )
}

function HardwareAdders({
  items,
  parts,
  assemblies,
  busy,
  onPer,
  onLog,
}: {
  items: HardwareRow[]
  parts: PartRow[]
  assemblies: AssemblyRow[]
  busy: boolean
  onPer: (target: { kind: 'part' | 'assembly'; id: string }, itemId: string, n: number) => Promise<void>
  onLog: (input: HardwareUseInput) => Promise<void>
}) {
  const targets = [
    ...parts.map((p) => ({ key: `part:${p.id}`, label: `${p.label} (each copy)` })),
    ...assemblies.map((a) => ({ key: `asm:${a.id}`, label: `${a.name} (assembly)` })),
  ]
  const [target, setTarget] = useState(targets[0]?.key ?? '')
  const [item, setItem] = useState(items[0]?.id ?? '')
  const [per, setPer] = useState('')
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const chosen = items.find((i) => i.id === item)
  return (
    <>
      {targets.length > 0 && (
        <div className="btnrow" style={{ marginTop: 8, alignItems: 'flex-end' }} role="group" aria-label="Hardware per part">
          <div className="fld" style={{ margin: 0, minWidth: 200 }}>
            <label className="lbl" htmlFor="ex-hw-target">Uses hardware</label>
            <select id="ex-hw-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="fld" style={{ margin: 0, minWidth: 160 }}>
            <label className="lbl" htmlFor="ex-hw-item">Piece</label>
            <select id="ex-hw-item" value={item} onChange={(e) => setItem(e.target.value)}>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fld" style={{ margin: 0, width: 90 }}>
            <label className="lbl" htmlFor="ex-hw-per">How many</label>
            <input id="ex-hw-per" type="number" min="1" step="1" value={per} onChange={(e) => setPer(e.target.value)} />
          </div>
          <button
            type="button"
            className="btn sm"
            disabled={busy || !target || !item || !(Number(per) > 0)}
            onClick={() => {
              const [kind, id] = target.split(':')
              void onPer({ kind: kind === 'part' ? 'part' : 'assembly', id }, item, Number(per)).then(() => setPer(''))
            }}
          >
            Set
          </button>
        </div>
      )}
      <div className="btnrow" style={{ marginTop: 8, alignItems: 'flex-end' }} role="group" aria-label="Log hardware used">
        <div className="fld" style={{ margin: 0, minWidth: 160 }}>
          <label className="lbl" htmlFor="ex-hw-log-item">Used by hand</label>
          <select id="ex-hw-log-item" value={item} onChange={(e) => setItem(e.target.value)}>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
        <div className="fld" style={{ margin: 0, width: 90 }}>
          <label className="lbl" htmlFor="ex-hw-qty">How many</label>
          <input id="ex-hw-qty" type="number" min="1" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        <div className="fld" style={{ margin: 0, flex: 1, minWidth: 140 }}>
          <label className="lbl" htmlFor="ex-hw-note">Note</label>
          <input id="ex-hw-note" value={note} placeholder="Glued into a copy that failed" onChange={(e) => setNote(e.target.value)} />
        </div>
        <button
          type="button"
          className="btn sm"
          disabled={busy || !item || !(Number(qty) > 0)}
          onClick={() =>
            void onLog({ itemId: item, qty: Number(qty), note: note || null }).then(() => {
              setQty('')
              setNote('')
            })
          }
        >
          Log it
        </button>
      </div>
      {chosen && chosen.available <= chosen.reorderAt && (
        <div className="hint" style={{ color: 'var(--warn)' }}>
          {chosen.name}: {Math.round(chosen.available * 100) / 100} left — time to reorder.
        </div>
      )}
    </>
  )
}
