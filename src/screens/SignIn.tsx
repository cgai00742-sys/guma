/**
 * Sign-in — the one surface with no design file.
 *
 * Built from the reveal spec in Guma Design System v2.dc.html: `.home` already
 * carries the whole cinematic moment in guma.css (panel rises, top hairline
 * lights, contents stagger at 40ms intervals via animation-delay on h2 / .sub /
 * .fld / .signin / .note). Applying the class IS the animation — no keyframes
 * are written here, and the whole thing is disabled under prefers-reduced-motion
 * by the design system.
 *
 * Two ways in, deliberately:
 *
 *   password    the default, because it always works. The owner has to be able
 *               to open this in front of a client, and an email that depends on
 *               a rate-limited mail service is not something to stand on.
 *   magic link  kept, because it is the better experience when mail is healthy
 *               and it is how staff will join once real SMTP is configured.
 *
 * This is still the functional minimum. It has not had a design pass.
 */
import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type Mode = 'password' | 'link'

/** Turn Supabase's terse errors into something that says what to do next. */
function explain(message: string, mode: Mode): string {
  const m = message.toLowerCase()
  if (m.includes('rate limit')) {
    return mode === 'link'
      ? "The mail service is rate limited — it allows only a couple of messages an hour. Sign in with your password instead, or try the link again later."
      : 'Too many attempts. Wait a moment and try again.'
  }
  if (m.includes('invalid login credentials')) {
    return 'That email and password do not match an account.'
  }
  if (m.includes('not authorized')) {
    return "This address is not on the mail service's allowed list yet. Use a password, or add the address in Supabase."
  }
  if (m.includes('email not confirmed')) {
    return 'This account has not confirmed its email address yet.'
  }
  return message
}

export default function SignIn() {
  const [mode, setMode] = useState<Mode>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function switchTo(next: Mode) {
    setMode(next)
    setError(null)
    setSent(false)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setError(null)

    if (mode === 'password') {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (error) setError(explain(error.message, mode))
      // On success the auth listener in App swaps the screen out.
    } else {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin },
      })
      if (error) setError(explain(error.message, mode))
      else setSent(true)
    }
    setBusy(false)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="home" style={{ maxWidth: 380 }}>
        <img
          src="/brand/guma-mark.svg"
          alt=""
          width={52}
          height={47}
          style={{
            display: 'block',
            margin: '0 auto 12px',
            filter: 'drop-shadow(0 0 26px color-mix(in srgb, var(--biolum) 40%, transparent))',
          }}
        />
        <h2>Guma</h2>
        <div className="sub">Sign in to the workspace</div>

        {sent ? (
          <>
            <div className="okbar" style={{ textAlign: 'left', marginTop: 16 }}>
              <span>Link sent to {email.trim()}. It signs you in on this device.</span>
            </div>
            <button type="button" className="btn" style={{ marginTop: 4 }} onClick={() => switchTo('password')}>
              Use a password instead
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="fld" style={{ textAlign: 'left', marginTop: 16 }}>
              <label className="lbl" htmlFor="signin-email">
                Email
              </label>
              <input
                id="signin-email"
                type="email"
                autoComplete="username"
                autoFocus
                placeholder="you@shop.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {mode === 'password' && (
              <div className="fld" style={{ textAlign: 'left', marginTop: 10 }}>
                <label className="lbl" htmlFor="signin-password">
                  Password
                </label>
                <input
                  id="signin-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            )}

            <button type="submit" className="btn primary signin" disabled={busy}>
              {busy ? (mode === 'password' ? 'Signing in…' : 'Sending…') : mode === 'password' ? 'Sign in' : 'Email me a link'}
            </button>

            {error && (
              <div className="alert" style={{ textAlign: 'left', marginTop: 10 }}>
                <span>{error}</span>
              </div>
            )}

            <button
              type="button"
              className="linkbtn"
              style={{ marginTop: 12, fontSize: 12 }}
              onClick={() => switchTo(mode === 'password' ? 'link' : 'password')}
            >
              {mode === 'password' ? 'Email me a link instead' : 'Use a password instead'}
            </button>
          </form>
        )}

        <div className="note">One printer · one house</div>
      </div>
    </div>
  )
}
