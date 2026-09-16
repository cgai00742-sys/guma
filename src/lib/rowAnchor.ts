/**
 * The row you clicked stays where you clicked it.
 *
 * Several tables in Guma open a drawer under a row — a client's details, a
 * material's purchase log, a part's history. Only one is open at a time, so
 * opening a row three hundred pixels below an already-open one closes that
 * one first, the list above shrinks, and the row you were aiming at slides
 * up the screen while you are still looking at where it used to be. Closing
 * a drawer above your position does the same thing.
 *
 * Browsers have a feature for exactly this — CSS scroll anchoring, which
 * quietly compensates when content above the viewport changes height. Every
 * browser has it except WebKit, and WebKit is what the desktop app is: a
 * Tauri window on macOS is a WKWebView. So the one place Guma actually
 * ships is the one place the browser will not do this for us, which is why
 * it is done here.
 *
 * The method is the obvious one: measure where the row is before the
 * change, measure again immediately after the DOM updates and before the
 * frame is painted, and scroll by the difference. useLayoutEffect rather
 * than useEffect is load-bearing — useEffect runs after paint, so the jump
 * would be drawn and then corrected, which is a flicker rather than a fix.
 */
import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * Which box actually scrolls around this element.
 *
 * Usually the page, but Guma's board lives inside its own scrolling
 * container (see the `body:has(.board)` chain in guma.css), and scrolling
 * the window when the window does not scroll is a silent no-op — the sort
 * of thing that works in a test and does nothing in the app.
 */
function scrollerOf(el: Element): Element {
  let node: Element | null = el.parentElement
  while (node) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return document.scrollingElement ?? document.documentElement
}

/**
 * Hand this the row element when a drawer is about to open or close, and
 * pass the state that opening changes as `openKey`. When that state moves,
 * the row is put back where it was.
 *
 *   const hold = useRowAnchor(openId)
 *   <tr onClick={(e) => { hold(e.currentTarget); setOpenId(...) }}>
 */
export function useRowAnchor(openKey: unknown): (row: Element | null) => void {
  const pending = useRef<{ row: Element; top: number } | null>(null)

  const hold = useCallback((row: Element | null) => {
    if (row) pending.current = { row, top: row.getBoundingClientRect().top }
  }, [])

  useLayoutEffect(() => {
    const held = pending.current
    pending.current = null
    // A row that has been filtered or sorted out of the list since the
    // click has no position to restore, and asking for one would read a
    // detached node's rect — zeros — and scroll to the top of the page.
    if (!held || !held.row.isConnected) return

    const moved = held.row.getBoundingClientRect().top - held.top
    // Sub-pixel drift is not a jump, and correcting it would fight the
    // browser's own rounding on every single click.
    if (Math.abs(moved) < 1) return

    scrollerOf(held.row).scrollBy(0, moved)
  }, [openKey])

  return hold
}
