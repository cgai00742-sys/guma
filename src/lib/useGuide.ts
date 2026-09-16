/**
 * The wiring between a screen, what it knows about the shop, and whether
 * Guma has anything to say about it.
 *
 * Screens do not decide what to show. They report where they are and what
 * the shop looks like; guide.ts decides whether a chapter qualifies, and
 * this hook remembers the answer. That split is deliberate — the trigger
 * rules are pure and tested in one place rather than scattered across four
 * screens as `useState(true)` flags that drift apart.
 *
 * GUIDANCE FAILS QUIETLY. Every database call here swallows its error. A
 * shop whose guide table is unreachable sees no chapters and an otherwise
 * working program, which is the correct trade: guidance is the first thing
 * to give up when something is wrong, never a reason a screen will not
 * load.
 *
 * SHOWN ONCE MEANS ONCE. The seen set is updated locally the moment a
 * chapter is dismissed, before the write lands, so the same window cannot
 * reappear on a re-render while the insert is in flight.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { listGuideSeen, markGuideSeen } from './data'
import { nextChapter, type Chapter, type GuideState } from './guide'

export function useGuide(shopId: string, state: GuideState | null) {
  const [seen, setSeen] = useState<Set<string> | null>(null)
  // Null until the seen set has loaded: showing a chapter before knowing
  // what has already been shown is how somebody gets the same window twice.
  const loaded = seen !== null

  useEffect(() => {
    let cancelled = false
    listGuideSeen(shopId)
      .then((ids) => {
        if (!cancelled) setSeen(new Set(ids))
      })
      .catch(() => {
        // Unreachable guide table: behave as though everything has been
        // seen. Silence is the safe failure here.
        if (!cancelled) setSeen(new Set(['*']))
      })
    return () => {
      cancelled = true
    }
  }, [shopId])

  const dismiss = useCallback(
    (id: string) => {
      setSeen((prev) => new Set(prev ?? []).add(id))
      markGuideSeen(shopId, id).catch(() => {
        // The write failed, so it may reappear next launch. Annoying, not
        // wrong, and far better than blocking on it.
      })
    },
    [shopId],
  )

  // Chapters are keyed off the seen set and the state the screen reports.
  // A chapter already dismissed in this session is gone immediately because
  // `seen` updated synchronously above.
  const suppressed = seen?.has('*') ?? false
  const chapter: Chapter | null =
    loaded && state && !suppressed ? nextChapter(state, seen!) : null

  // Once a chapter is on screen it stays on screen, even if the state that
  // triggered it changes underneath -- a window that vanishes mid-sentence
  // because a number loaded in the background is worse than no window.
  const held = useRef<Chapter | null>(null)
  if (chapter && !held.current) held.current = chapter
  if (held.current && seen?.has(held.current.id)) held.current = null

  return { chapter: held.current, dismiss }
}
