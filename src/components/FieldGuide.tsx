/**
 * The box under a rate or cost field that tries to make it answerable.
 *
 * Three different kinds of help can appear here, and they are deliberately
 * not presented as equals, because they are not equally trustworthy. In
 * descending order of authority:
 *
 *   YOURS      — computed from numbers this shop supplied about its own
 *                machine, bill or spool. Arithmetic. Offered with a button
 *                that fills the field, because accepting your own division
 *                is not accepting a recommendation. (derive.ts)
 *
 *   HISTORY    — this shop's own finished jobs, added up. Also not a
 *                recommendation; it is a measurement of them. Never fills
 *                a field, because "what you have been getting" and "what
 *                you should charge" are different questions. (history.ts)
 *
 *   PUBLISHED  — what other shops charge, per a cited source, shown with
 *                the publication and the date attached and only in a
 *                currency the figure was actually collected in. The only
 *                genuinely external opinion on the screen, so it is last,
 *                it is always attributed, and it never fills a field.
 *                (benchmarks.ts)
 *
 * Source URLs render as plain text, not links, for the reason TaxNameHint
 * documents: a Tauri window has no reliable way to hand a URL to the system
 * browser without navigating the app away from itself.
 */
import type { Benchmark } from '../lib/benchmarks'

/**
 * Formats a benchmark figure in its own units. Money figures go through the
 * shop's own formatter, so a cited dollar range is shown with the shop's
 * separators -- it is only ever shown to a shop invoicing in that currency
 * in the first place, so there is no conversion happening here, only
 * typography.
 */
export function makeBenchmarkFormatter(money: (n: number) => string) {
  return (n: number, b: Benchmark): string => {
    switch (b.unit) {
      case 'per-hour':
        return `${money(n)}/h`
      case 'per-kg':
        return `${money(n)}/kg`
      case 'flat':
        return money(n)
      case 'multiple':
        return `${n}\u00d7`
      case 'percent':
        return `${n}%`
      case 'hours':
        return `${n.toLocaleString()} h`
      default:
        return String(n)
    }
  }
}

/** Said to a shop whose currency Guma holds no published figures for. */
export function noLocalRatesNote(currency: string, rated: string[]): string {
  return (
    `Guma has no published rate data for ${currency || 'your currency'}. ` +
    `The figures it does hold were collected in ${rated.join(' and ')} and are not shown here, ` +
    `because a converted rate would look researched while being a guess about your market. ` +
    `Anything above that is a ratio, a percentage or a count of hours holds anywhere, ` +
    `and your own history will be the better guide once you have a few jobs through.`
  )
}

export interface DerivedOffer {
  /** Short label for what was computed, e.g. "Wear per hour". */
  label: string
  /** Formatted for display — the caller owns currency and rounding. */
  display: string
  /** How it was arrived at, in words, including any input still missing. */
  workings: string
  /** Raw value, written into the field when the shop accepts it. */
  value: number
  /** Omit to show the figure without offering to fill anything. */
  onAccept?: (value: number) => void
}

function rangeText(b: Benchmark, fmt: (n: number) => string): string {
  const lo = fmt(b.low)
  if (b.high === null) return `${lo} and up`
  if (b.high === b.low) return lo
  return `${lo} – ${fmt(b.high)}`
}

export default function FieldGuide({
  derived,
  history,
  benchmarks,
  formatBenchmark,
  noLocalRates,
}: {
  derived?: DerivedOffer | null
  /** One plain sentence from the shop's own history, or null. */
  history?: string | null
  benchmarks?: Benchmark[]
  /** Formats a benchmark figure in its own units. */
  formatBenchmark?: (n: number, b: Benchmark) => string
  /**
   * Shown when Guma holds no published money figures for this shop's
   * currency. Saying so out loud is the point: the alternative is a shop in
   * Kraków quietly reading dollar rates as if they were advice.
   */
  noLocalRates?: string | null
}) {
  const hasBenchmarks = !!benchmarks && benchmarks.length > 0
  if (!derived && !history && !hasBenchmarks && !noLocalRates) return null

  const fmt = formatBenchmark ?? ((n: number) => String(n))

  return (
    <div className="guide">
      {derived && (
        <div className="guide-row">
          <span className="guide-tag">Yours</span>
          <span>
            <b>
              {derived.label}: {derived.display}
            </b>{' '}
            <span className="guide-why">{derived.workings}</span>
            {derived.onAccept && (
              <>
                {' '}
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => derived.onAccept?.(derived.value)}
                >
                  Use it
                </button>
              </>
            )}
          </span>
        </div>
      )}

      {history && (
        <div className="guide-row">
          <span className="guide-tag">Your history</span>
          <span className="guide-why">{history}</span>
        </div>
      )}

      {hasBenchmarks &&
        benchmarks!.map((b) => (
          <div className="guide-row" key={b.id}>
            <span className="guide-tag alt">Published</span>
            <span>
              <b>
                {b.label}: {rangeText(b, (n) => fmt(n, b))}
              </b>{' '}
              <span className="guide-why">
                {b.note} <span className="guide-src">{b.source}, {b.asOf} · {b.url}</span>
              </span>
            </span>
          </div>
        ))}

      {noLocalRates && (
        <div className="guide-row">
          <span className="guide-tag alt">No local data</span>
          <span className="guide-why">{noLocalRates}</span>
        </div>
      )}
    </div>
  )
}
