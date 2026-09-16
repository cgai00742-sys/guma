/**
 * One box that finds anything in the shop.
 *
 * Guma's things live on four screens and two of them are tabs inside a
 * third. Knowing that a spool of grey PETG is under Shop settings → Materials
 * is knowledge about Guma, not about running a print shop, and every minute
 * spent acquiring it is a minute the tool took rather than gave. So: type a
 * name, press Enter, arrive.
 *
 * The index is built when the box opens, not held in state between opens.
 * Everything it reads is a local SQLite query over a few hundred rows at
 * most, and the alternative — a cached index invalidated on every write in
 * the app — is a much larger amount of machinery whose failure mode is
 * telling somebody a client does not exist. Rebuilding is cheap; being
 * wrong is not.
 *
 * Cmd-K (Ctrl-K on Windows and Linux) from anywhere, Escape to leave,
 * arrows to move, Enter to go. Those are the bindings every tool with a
 * search box has had for a decade, and a shop that has used any of them
 * already knows these.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listClients, listJobs, listMaterials, toRateSet, type ShopContext } from '../lib/data'
import { makeMoney } from '../lib/pricing'
import { KIND_LABEL, marks, search, type SearchHit, type SearchItem } from '../lib/search'
import { clientItem, machineItem, materialItem, projectItem } from '../lib/searchItems'

/** A screenful. More than this and nobody is reading, they are scrolling —
 *  and a query that returns thirty things wants to be a narrower query. */
const LIMIT = 8

export default function GlobalSearch({ ctx }: { ctx: ShopContext }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<SearchItem[] | null>(null)
  const [cursor, setCursor] = useState(0)
  const box = useRef<HTMLDivElement | null>(null)
  const field = useRef<HTMLInputElement | null>(null)

  const { money } = useMemo(() => {
    const rates = toRateSet(ctx.rateCard, ctx.shop)
    return makeMoney(rates.currency, rates.locale)
  }, [ctx.rateCard, ctx.shop])

  const build = useCallback(async () => {
    const [jobs, clients, materials] = await Promise.all([
      listJobs(ctx.shop.id),
      listClients(ctx.shop.id),
      listMaterials(ctx.shop.id),
    ])
    setIndex([
      ...jobs.map((j) => projectItem(j, money)),
      ...clients.map((c) => clientItem(c, money)),
      // From context rather than a query: Settings already has them, and
      // they include the retired ones, which someone may well be searching
      // for precisely because they want to put one back in service.
      ...ctx.printerRows.map(machineItem),
      ...materials.map(materialItem),
    ])
  }, [ctx.shop.id, ctx.printerRows, money])

  // Cmd-K / Ctrl-K from anywhere, including from inside a form field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
        field.current?.focus()
        field.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open && index === null) void build()
  }, [open, index, build])

  // Clicking anywhere else closes it. Without this the panel outlives the
  // question that opened it and sits over the screen you wanted to read.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const hits: SearchHit[] = useMemo(
    () => (index ? search(index, query, { limit: LIMIT }) : []),
    [index, query],
  )

  useEffect(() => {
    setCursor(0)
  }, [query])

  function go(hit: SearchHit) {
    setOpen(false)
    setQuery('')
    navigate(hit.to)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false)
      field.current?.blur()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, Math.max(hits.length - 1, 0)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
      return
    }
    if (e.key === 'Enter' && hits[cursor]) {
      e.preventDefault()
      go(hits[cursor])
    }
  }

  const searched = query.trim().length > 0

  return (
    <div ref={box} style={{ position: 'relative', flex: '1 1 240px', maxWidth: 340, minWidth: 160 }}>
      <input
        ref={field}
        type="search"
        role="searchbox"
        value={query}
        aria-label="Search everything in the shop"
        placeholder="Search everything  ⌘K"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        style={{ width: '100%' }}
      />

      {open && searched && (
        <div
          role="listbox"
          aria-label="Search results"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            zIndex: 60,
            background: 'var(--panel)',
            border: '1px solid var(--line-strong)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 18px 40px rgba(0,0,0,.45)',
            overflow: 'hidden',
            maxHeight: '70vh',
            overflowY: 'auto',
          }}
        >
          {index === null ? (
            <div style={{ padding: '12px 12px', fontSize: 12, color: 'var(--txt-3)' }}>Looking…</div>
          ) : hits.length === 0 ? (
            <div style={{ padding: '12px 12px', fontSize: 12, color: 'var(--txt-3)' }}>
              Nothing in the shop matches “{query.trim()}”.
            </div>
          ) : (
            hits.map((hit, i) => (
              <button
                key={`${hit.kind}:${hit.id}`}
                type="button"
                role="option"
                aria-selected={i === cursor}
                /**
                 * The label is stated rather than left to be computed from
                 * the contents, because the contents are deliberately
                 * chopped up to bold the matched letters -- and a screen
                 * reader glues those fragments back together without the
                 * spaces, so "Prusa XL" searched for as "prusa" is
                 * announced as "PrusaXL". The name a person hears should
                 * not depend on what they happened to type.
                 */
                aria-label={[hit.title, hit.subtitle, hit.badge].filter(Boolean).join(' — ')}
                // Selection follows the mouse as well as the arrows, so
                // hovering one row and pressing Enter does not open a
                // different one.
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(hit)}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  font: 'inherit',
                  cursor: 'pointer',
                  padding: '9px 12px',
                  border: 'none',
                  borderBottom: '1px solid var(--line)',
                  background: i === cursor ? 'var(--panel-3)' : 'transparent',
                  color: 'var(--txt)',
                }}
              >
                <span
                  className="chip"
                  style={{ flex: 'none', fontSize: 10, textTransform: 'lowercase' }}
                >
                  {KIND_LABEL[hit.kind].replace(/s$/, '')}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ fontWeight: 500, display: 'block' }}>
                    {marks(hit.title, query).map((m, k) =>
                      m.hit ? (
                        <b key={k} style={{ color: 'var(--ember)' }}>
                          {m.text}
                        </b>
                      ) : (
                        <span key={k}>{m.text}</span>
                      ),
                    )}
                  </span>
                  {hit.subtitle && (
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--txt-3)' }}>
                      {hit.subtitle}
                    </span>
                  )}
                </span>
                {hit.badge && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-2)', flex: 'none' }}>
                    {hit.badge}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
