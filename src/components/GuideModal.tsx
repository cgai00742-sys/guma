/**
 * One chapter of the program, explained at the moment it becomes relevant.
 *
 * Not a tour. See src/lib/guide.ts for why, and for the rules about when a
 * chapter is allowed to fire; this file is only the window it appears in.
 *
 * Uses the native <dialog> already styled in guma.css section 4.4, the same
 * element WelcomeModal uses, so guidance looks like the rest of the program
 * rather than like something bolted to the front of it.
 *
 * Dismissing is final. There is no "remind me later", because a chapter
 * that can come back is a chapter people learn to swat rather than read,
 * and because everything here is discoverable without it -- the modal is a
 * shortcut past a discovery, not a gate in front of one.
 */
import { useEffect, useRef } from 'react'
import type { Chapter } from '../lib/guide'

export default function GuideModal({
  chapter,
  onClose,
  onAction,
}: {
  chapter: Chapter | null
  /** Called once, with the chapter id, when the window is closed by any
   *  route -- the button, Escape, or the action. The caller records it as
   *  seen; this component never writes anything itself. */
  onClose: (id: string) => void
  /** Only called when the chapter offers an action and the user takes it.
   *  The screen decides what it means. */
  onAction?: (id: string) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (chapter && !el.open) el.showModal()
    if (!chapter && el.open) el.close()
  }, [chapter])

  // Escape closes a native dialog without going through our buttons, and it
  // still counts as having been shown -- otherwise the same window would
  // reappear on the next visit and the dismissal would have meant nothing.
  useEffect(() => {
    const el = ref.current
    if (!el || !chapter) return
    const onCancel = () => onClose(chapter.id)
    el.addEventListener('close', onCancel)
    return () => el.removeEventListener('close', onCancel)
  }, [chapter, onClose])

  if (!chapter) return null

  return (
    <dialog ref={ref} aria-labelledby="guide-title">
      <div className="dlg-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="guide-tag">Guma</span>
          <b id="guide-title" style={{ fontSize: 14 }}>{chapter.title}</b>
        </div>
      </div>

      <div className="dlg-body">
        <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--txt-2)' }}>
          {chapter.lede}
        </div>
        <div className="guide" style={{ marginTop: 12 }}>
          <div className="guide-g">
            <div className="guide-kv">
              {chapter.points.map((p) => (
                <div className="guide-r" key={p}>
                  <span className="k" style={{ flex: 1 }}>{p}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="dlg-foot">
        <button type="button" className="btn" onClick={() => ref.current?.close()}>
          Got it
        </button>
        {chapter.action && onAction && (
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              onAction(chapter.id)
              ref.current?.close()
            }}
          >
            {chapter.action}
          </button>
        )}
      </div>
    </dialog>
  )
}
