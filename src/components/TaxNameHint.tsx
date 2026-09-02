/**
 * The tax-name suggestion box shown next to "Tax name" wherever a shop's
 * state is on file. See src/lib/taxHelp.ts for why this only ever suggests
 * a NAME, never a rate. The link is rendered as plain text rather than a
 * clickable one on purpose -- a Tauri window has no reliable, unconfigured
 * way to open a link in the system browser without navigating the app's own
 * window away from itself, which would be worse than not linking at all.
 */
import type { TaxHint } from '../lib/taxHelp'

export default function TaxNameHint({ hint, onUseLabel }: { hint: TaxHint; onUseLabel: (label: string) => void }) {
  return (
    <div className="notice" style={{ marginTop: 10 }}>
      <span>
        <b>{hint.label}.</b> {hint.note} Confirm the current details at:{' '}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{hint.link}</span>
      </span>
      <div style={{ marginTop: 8 }}>
        <button type="button" className="btn sm" onClick={() => onUseLabel(hint.label)}>
          Use “{hint.label}” as the tax name
        </button>
      </div>
    </div>
  )
}
