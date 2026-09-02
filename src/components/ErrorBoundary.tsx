/**
 * Last resort. Nothing else in this app catches a render-time exception —
 * React just unmounts the tree and leaves a blank window, which is exactly
 * what happened when the desktop quote-PDF view crashed on a malformed
 * rates_snapshot (see data.local.ts's loadQuoteForPrint). A blank screen
 * gives a shop owner nothing to act on and nothing to send us; this at
 * least shows the error and a way back.
 *
 * Deliberately not fancy: a class component because that's still the only
 * way React exposes componentDidCatch, and no retry-with-backoff or
 * telemetry — just "stop hiding the failure."
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Guma crashed while rendering:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="wrap" style={{ paddingTop: 24 }}>
        <div className="attn crit">
          <div>
            <b>Something went wrong rendering this screen.</b>
            <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11 }}>
              {error.message}
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              Nothing was lost — quotes and shop data are saved as you go, not held in this
              screen. Go back and try again; if it keeps happening, this message is what to
              share when reporting it.
            </div>
            <button
              type="button"
              className="btn sm"
              style={{ marginTop: 10 }}
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
