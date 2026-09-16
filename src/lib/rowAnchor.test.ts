// @vitest-environment jsdom
/**
 * Keeping a clicked row still.
 *
 * jsdom does no layout, so every rectangle here is stated rather than
 * measured — which is fine, because the thing worth testing is the
 * arithmetic and the refusals, not whether a browser can add. The browser
 * half was checked against a real Chromium.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRowAnchor } from './rowAnchor'

/** A row that claims to be at `top`, in a page that scrolls. */
function rowAt(top: number) {
  const row = document.createElement('tr')
  document.body.appendChild(row)
  let current = top
  row.getBoundingClientRect = () => ({ top: current }) as DOMRect
  return {
    row,
    /** The drawer above it opened or closed and pushed it. */
    moveTo: (next: number) => {
      current = next
    },
  }
}

let scrolled: number[] = []

beforeEach(() => {
  document.body.innerHTML = ''
  scrolled = []
  const scroller = document.documentElement
  Object.defineProperty(document, 'scrollingElement', { value: scroller, configurable: true })
  scroller.scrollBy = ((_x: number, y: number) => {
    scrolled.push(y)
  }) as unknown as typeof scroller.scrollBy
})

describe('a row that moves is put back', () => {
  it('scrolls by exactly what the row moved', () => {
    const { row, moveTo } = rowAt(400)
    const { result, rerender } = renderHook(({ open }) => useRowAnchor(open), {
      initialProps: { open: 'a' as string | null },
    })

    act(() => result.current(row))
    // Closing the drawer above it pulls this row 260px up the screen.
    moveTo(140)
    rerender({ open: null })

    expect(scrolled).toEqual([-260])
  })

  it('works in the other direction, when a drawer opens above', () => {
    const { row, moveTo } = rowAt(140)
    const { result, rerender } = renderHook(({ open }) => useRowAnchor(open), {
      initialProps: { open: null as string | null },
    })

    act(() => result.current(row))
    moveTo(400)
    rerender({ open: 'a' })

    expect(scrolled).toEqual([260])
  })
})

describe('what it refuses to do', () => {
  it('does nothing when the row did not move', () => {
    const { row } = rowAt(400)
    const { result, rerender } = renderHook(({ open }) => useRowAnchor(open), {
      initialProps: { open: null as string | null },
    })
    act(() => result.current(row))
    rerender({ open: 'a' })
    expect(scrolled).toEqual([])
  })

  it('ignores sub-pixel drift rather than fighting the browser on every click', () => {
    const { row, moveTo } = rowAt(400)
    const { result, rerender } = renderHook(({ open }) => useRowAnchor(open), {
      initialProps: { open: null as string | null },
    })
    act(() => result.current(row))
    moveTo(400.4)
    rerender({ open: 'a' })
    expect(scrolled).toEqual([])
  })

  it('does not scroll to the top when the row has left the list', () => {
    // A search typed after the click, or a sort that moved the row out.
    // A detached node reports a rect of zeros, and treating that as a real
    // position would throw the page to the top -- worse than the jump.
    const { row } = rowAt(400)
    const { result, rerender } = renderHook(({ open }) => useRowAnchor(open), {
      initialProps: { open: null as string | null },
    })
    act(() => result.current(row))
    row.remove()
    rerender({ open: 'a' })
    expect(scrolled).toEqual([])
  })

  it('does nothing when no row was held — a state change nobody clicked', () => {
    const { rerender } = renderHook(({ open }) => useRowAnchor(open), {
      initialProps: { open: null as string | null },
    })
    rerender({ open: 'a' })
    expect(scrolled).toEqual([])
  })

  it('forgets the row after one correction, so a later re-render does not move the page', () => {
    const { row, moveTo } = rowAt(400)
    const { result, rerender } = renderHook(({ open }) => useRowAnchor(open), {
      initialProps: { open: null as string | null },
    })
    act(() => result.current(row))
    moveTo(300)
    rerender({ open: 'a' })
    expect(scrolled).toEqual([-100])

    // Something else re-renders the list -- a save, a reload. Nothing was
    // clicked, so nothing should scroll.
    moveTo(50)
    rerender({ open: 'b' })
    expect(scrolled).toEqual([-100])
  })
})
