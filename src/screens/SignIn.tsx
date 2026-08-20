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
 * This is deliberately the functional minimum: magic link only, no password, no
 * sign-up copy, no shop switcher. CG wants to see it before it goes further.
 */
import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setState('sending')
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    })
    if (error) {
      setState('error')
      setMessage(error.message)
    } else {
      setState('sent')
      setMessage(`Link sent to ${email.trim()}. It signs you in on this device.`)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
      }}
    >
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

        {state === 'sent' ? (
          <>
            <div className="okbar" style={{ textAlign: 'left', marginTop: 16 }}>
              <span>{message}</span>
            </div>
            <button type="button" className="btn" style={{ marginTop: 4 }} onClick={() => setState('idle')}>
              Use a different address
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
                autoComplete="email"
                autoFocus
                placeholder="you@shop.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button type="submit" className="btn primary signin" disabled={state === 'sending'}>
              {state === 'sending' ? 'Sending…' : 'Continue'}
            </button>
            {state === 'error' && (
              <div className="alert" style={{ textAlign: 'left', marginTop: 10 }}>
                <span>{message}</span>
              </div>
            )}
          </form>
        )}

        <div className="note">One printer · one house</div>
      </div>
    </div>
  )
}
