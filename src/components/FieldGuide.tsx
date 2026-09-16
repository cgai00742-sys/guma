/**
 * The guidance strip under a rate or cost field.
 *
 * It answers one question — "what does this number do?" — in the vocabulary
 * the rest of the app already uses for exactly that: a label on the left, a
 * figure on the right, mono and tabular so a column of them lines up. The
 * "what this does to a typical project" panel on the rates tab is the same
 * shape, deliberately.
 *
 * The first version of this was paragraphs. It was accurate and nobody was
 * going to read it, which makes accuracy beside the point. Everything here
 * is now a row or a short clause, and anything that could not survive being
 * a row was cut rather than shrunk.
 *
 * Three tiers, ranked by how much authority they deserve, ordered so the
 * shop's own numbers come first and an outside opinion comes last:
 *
 *   Yours      arithmetic on what this shop supplied. May offer to fill the
 *              field, because accepting your own division is not accepting
 *              a recommendation.
 *   Yours/past this shop's finished jobs. Never fills a field.
 *   Published  a cited outside figure, always with its source and date, and
 *              only ever in a currency it was actually collected in.
 *
 * Source URLs are plain text, not links: a Tauri window has no reliable way
 * to hand a URL to the system browser without navigating the app away from
 * itself. See TaxNameHint, which documents the same constraint.
 */
import type { Benchmark } from '../lib/benchmarks'

export interface GuideRow {
  label: string
  /** Already formatted. The caller owns currency and rounding. */
  value: string
}

export interface GuideGroup {
  /** Short chip: "Yours", "Your jobs", "Published". */
  tag: string
  /** True for the shop's own arithmetic/history, false for outside figures.
   *  Drives the chip colour, nothing else. */
  own?: boolean
  rows: GuideRow[]
  /** At most one short clause. Anything longer belongs in the docs. */
  note?: string
  /** Publication and date, e.g. "LayerMath 2026". */
  cite?: string
  /** Renders a small button, used only to fill a field from arithmetic. */
  action?: { label: string; onClick: () => void }
}

/** Formats a benchmark's range in its own units, compactly. */
export function makeBenchmarkFormatter(money: (n: number) => string) {
  const one = (n: number, b: Benchmark): string => {
    switch (b.unit) {
      case 'per-hour':
        return `${money(n)}/h`
      case 'per-kg':
        return `${money(n)}/kg`
      case 'flat':
        return money(n)
      case 'multiple':
        return `${n}×`
      case 'percent':
        return `${n}%`
      case 'hours':
        return `${n.toLocaleString()} h`
      default:
        return String(n)
    }
  }
  return (b: Benchmark): string => {
    if (b.high === null) return `${one(b.low, b)}+`
    if (b.high === b.low) return one(b.low, b)
    // Only the high end carries the unit: "$25 – $45/h" reads faster than
    // "$25.00/h – $45.00/h" and says the same thing.
    const lo = b.unit === 'per-hour' || b.unit === 'per-kg' ? money(b.low) : one(b.low, b)
    return `${lo} – ${one(b.high, b)}`
  }
}

/** Turns cited figures into one compact group. Null when there are none. */
export function benchmarkGroup(
  benchmarks: Benchmark[],
  fmt: (b: Benchmark) => string,
): GuideGroup | null {
  if (benchmarks.length === 0) return null
  const cites = [...new Set(benchmarks.map((b) => `${b.sourceShort} ${b.asOf}`))]
  const caveats = [...new Set(benchmarks.map((b) => b.caveat).filter(Boolean))]
  return {
    tag: 'Published',
    rows: benchmarks.map((b) => ({ label: b.label, value: fmt(b) })),
    note: caveats.join(' '),
    cite: cites.join(' · '),
  }
}

export default function FieldGuide({
  groups,
}: {
  /** Falsy entries are dropped, so a call site can write `cond && {...}`. */
  groups: (GuideGroup | null | undefined | false)[]
}) {
  const live = groups.filter((g): g is GuideGroup => !!g && g.rows.length + (g.note ? 1 : 0) > 0)
  if (live.length === 0) return null

  return (
    <div className="guide">
      {live.map((g, i) => (
        <div className="guide-g" key={`${g.tag}-${i}`}>
          <div className="guide-h">
            <span className={g.own ? 'guide-tag' : 'guide-tag alt'}>{g.tag}</span>
            {g.action && (
              <button type="button" className="btn sm" onClick={g.action.onClick}>
                {g.action.label}
              </button>
            )}
          </div>
          {g.rows.length > 0 && (
            <div className="guide-kv">
              {g.rows.map((r) => (
                <div className="guide-r" key={r.label}>
                  <span className="k">{r.label}</span>
                  <span className="v">{r.value}</span>
                </div>
              ))}
            </div>
          )}
          {g.note && <div className="guide-note">{g.note}</div>}
          {g.cite && <div className="guide-src">{g.cite}</div>}
        </div>
      ))}
    </div>
  )
}
