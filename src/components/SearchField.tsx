/**
 * A search box, the same one everywhere.
 *
 * Small, and worth having as a component anyway, because the two things
 * that make a filter field tolerable are the two things people leave out:
 * a way to clear it that is not "select all and delete", and a count of
 * what it is hiding. Without the count, a filter that matches nothing and a
 * shop that owns nothing look identical, and someone goes and adds a second
 * copy of a client they already have.
 *
 * Escape clears. There is no debounce: this filters an array that is
 * already in memory, and a delay between a keystroke and the list moving is
 * a delay nobody asked for.
 */
export default function SearchField({
  value,
  onChange,
  placeholder,
  hidden = 0,
  noun = 'row',
  autoFocus,
  id,
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
  /** How many rows the query is currently hiding. */
  hidden?: number
  /** Singular noun for the count line — "client", "project", "machine". */
  noun?: string
  autoFocus?: boolean
  id?: string
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          id={id}
          type="search"
          role="searchbox"
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              onChange('')
            }
          }}
          style={{ maxWidth: 380 }}
        />
        {value && (
          <button type="button" className="btn sm ghost" onClick={() => onChange('')}>
            Clear
          </button>
        )}
        {value && hidden > 0 && (
          <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>
            {hidden} {noun}
            {hidden === 1 ? '' : 's'} hidden
          </span>
        )}
      </div>
    </div>
  )
}
