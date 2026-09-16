/**
 * Saving, made visible.
 *
 * The complaint that produced this file was "the save feature of adding
 * clients or printers is not smooth", and the reason is not that saving was
 * slow. It is that saving was invisible. Every save button in Guma did the
 * same three things: disable itself, say "Saving…" for about eighty
 * milliseconds, and go back to saying "Save". On a local SQLite file that
 * is far too fast to see, so the button appeared not to do anything at all,
 * and the only way to find out whether the change had stuck was to navigate
 * away and come back.
 *
 * A save has three outcomes worth telling someone about -- it is happening,
 * it worked, it did not -- and "it worked" was the one nothing ever said.
 * So it gets said, and it gets said for long enough to read.
 *
 * Deliberately not a toast in a corner. A confirmation that appears far
 * away from the thing it is about makes you look in two places; this stays
 * on the control you pressed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

/** How long "Saved" stays up. Long enough to notice after looking away for
 *  a moment, short enough that it is clearly about the last thing you did
 *  rather than a permanent label. */
const HOLD_MS = 2400

/**
 * What a save turned out to be.
 *
 * The error comes back from the call rather than only being readable off
 * `saver.error`, and that is not a convenience. Reading it off the hook
 * immediately after awaiting is reading the render BEFORE the failed one --
 * the state has been set, React has not re-rendered, and the closure still
 * holds null. Written that way, a screen catches the failure and then
 * displays nothing at all, which is the exact class of bug this whole file
 * exists to stop.
 */
export interface SaveResult {
  ok: boolean
  error: string | null
}

export interface Saver {
  state: SaveState
  error: string | null
  /** Runs the work and tracks the three outcomes. Returns what happened, so
   *  a caller can close a form only on success and show the message without
   *  waiting for a re-render. */
  save: (work: () => Promise<unknown>) => Promise<SaveResult>
  /** Back to idle, and drop any error. For forms that reset themselves. */
  reset: () => void
}

export function useSaver(): Saver {
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A save that finishes after its screen has gone would otherwise set
  // state on an unmounted component, and the "Saved" timer would outlive
  // the thing it belongs to.
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setState('idle')
    setError(null)
  }, [])

  const save = useCallback(async (work: () => Promise<unknown>) => {
    if (timer.current) clearTimeout(timer.current)
    setState('saving')
    setError(null)
    try {
      await work()
      if (!alive.current) return { ok: true, error: null }
      setState('saved')
      timer.current = setTimeout(() => {
        if (alive.current) setState('idle')
      }, HOLD_MS)
      return { ok: true, error: null }
    } catch (e) {
      // The refusals Guma raises -- a client with projects, a machine with
      // build runs -- are written to be read by the person who tried. They
      // are the message, not a fallback for one.
      const message = e instanceof Error ? e.message : String(e)
      if (!alive.current) return { ok: false, error: message }
      setState('failed')
      setError(message)
      return { ok: false, error: message }
    }
  }, [])

  return { state, error, save, reset }
}

/**
 * A save button that says which of the three things is happening.
 *
 * Stays enabled while showing "Saved", so pressing it twice in a row does
 * the obvious thing instead of feeling stuck.
 */
export function SaveButton({
  saver,
  onClick,
  children = 'Save',
  savedLabel = 'Saved',
  disabled,
  className = 'btn primary',
  ...rest
}: {
  saver: Saver
  onClick: () => void
  children?: React.ReactNode
  savedLabel?: string
  disabled?: boolean
  className?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'className'>) {
  const { state } = saver
  return (
    <button
      type="button"
      className={className}
      // Screen readers otherwise get nothing at all out of a label that
      // changes from "Save" to "Saved": aria-live announces the change the
      // same moment the tick appears.
      aria-live="polite"
      disabled={disabled || state === 'saving'}
      onClick={onClick}
      {...rest}
    >
      {state === 'saving' ? 'Saving…' : state === 'saved' ? `${savedLabel} ✓` : children}
    </button>
  )
}

/**
 * A one-line confirmation for things that are not a button press -- a row
 * added, a machine retired. Same lifetime rules as the button, same reason.
 */
export function Flash({ message, tone = 'ok' }: { message: string | null; tone?: 'ok' | 'bad' }) {
  if (!message) return null
  return (
    <div
      role="status"
      style={{
        fontSize: 12,
        marginBottom: 10,
        padding: '7px 10px',
        borderRadius: 'var(--radius)',
        border: '1px solid',
        borderColor:
          tone === 'ok'
            ? 'color-mix(in srgb, var(--ok) 45%, transparent)'
            : 'color-mix(in srgb, var(--red) 45%, transparent)',
        background:
          tone === 'ok'
            ? 'color-mix(in srgb, var(--ok) 10%, transparent)'
            : 'color-mix(in srgb, var(--red) 10%, transparent)',
        color: tone === 'ok' ? 'var(--ok)' : 'var(--red)',
      }}
    >
      {message}
    </div>
  )
}

/**
 * A message that clears itself. For "Added Hafen GmbH" -- true, useful for
 * a few seconds, and clutter a minute later.
 */
export function useFlash(): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const flash = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current)
    setMessage(next)
    timer.current = setTimeout(() => setMessage(null), 4000)
  }, [])
  return [message, flash]
}
