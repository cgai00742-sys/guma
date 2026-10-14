/**
 * A duration typed as hours and minutes (CG, 14 Oct 2026: "hours and
 * minutes instead of for example 0.5 for 30 minutes").
 *
 * Two boxes, h and m, holding what was typed; the value going out is
 * decimal hours, which is what every table and every rate already uses
 * (lib/duration.ts). The first box takes the field's own <label> through
 * `id`; the second names itself "<label> (minutes)". 90 minutes is fine to
 * type -- it is 1h 30m.
 *
 * When the value is changed from outside -- a calculator filling it in --
 * the boxes follow; while a person is typing they are left alone.
 */
import { useEffect, useState } from 'react'
import { joinHours, splitHours } from '../lib/duration'

export default function HoursInput({
  id,
  value,
  onChange,
  label,
  disabled,
  compact,
}: {
  id?: string
  /** Decimal hours. Null or 0 shows empty boxes. */
  value: number | null | undefined
  onChange: (hours: number | null) => void
  /** The field's name, for the minutes box: "Machine time" -> "Machine time (minutes)". */
  label: string
  disabled?: boolean
  /** Narrower boxes, for a table cell. */
  compact?: boolean
}) {
  const show = (v: number | null | undefined) => {
    if (!v) return { h: '', m: '' }
    const s = splitHours(v)
    return { h: String(s.h), m: String(s.m) }
  }
  const [h, setH] = useState(() => show(value).h)
  const [m, setM] = useState(() => show(value).m)

  useEffect(() => {
    const typed = h === '' && m === '' ? 0 : joinHours(h, m)
    // Half a minute of slack: what was typed rounds to the minute.
    if (Math.abs(typed - (Number(value) || 0)) > 1 / 120) {
      const s = show(value)
      setH(s.h)
      setM(s.m)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const emit = (hh: string, mm: string) => onChange(hh === '' && mm === '' ? null : joinHours(hh, mm))
  const w = compact ? 46 : 64

  return (
    <span className={`hm${compact ? ' compact' : ''}`}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        value={h}
        disabled={disabled}
        aria-label={id ? undefined : `${label} (hours)`}
        style={{ width: w }}
        onChange={(e) => {
          setH(e.target.value)
          emit(e.target.value, m)
        }}
      />
      <span className="hm-u">h</span>
      <input
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        value={m}
        disabled={disabled}
        aria-label={`${label} (minutes)`}
        style={{ width: w }}
        onChange={(e) => {
          setM(e.target.value)
          emit(h, e.target.value)
        }}
      />
      <span className="hm-u">m</span>
    </span>
  )
}
