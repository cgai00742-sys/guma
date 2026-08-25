import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import { loadShopContext, NeedsSetup, type ShopContext } from './lib/data'
import SignIn from './screens/SignIn'
import Setup from './screens/Setup'
import Settings from './screens/Settings'
import Intake from './screens/Intake'
import QuoteDoc from './screens/QuoteDoc'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [ctx, setCtx] = useState<ShopContext | null>(null)
  const [ctxError, setCtxError] = useState<string | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const location = useLocation()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const refresh = useCallback(async () => {
    try {
      setCtx(await loadShopContext())
      setCtxError(null)
      setNeedsSetup(false)
    } catch (e) {
      if (e instanceof NeedsSetup) {
        setNeedsSetup(true)
        setCtxError(null)
      } else {
        setCtxError(e instanceof Error ? e.message : String(e))
      }
    }
  }, [])

  useEffect(() => {
    if (session) void refresh()
    else setCtx(null)
  }, [session, refresh])

  if (!ready) return null

  // The print view is its own full-bleed document: no app chrome, no dark
  // surface behind it. doc-page.js owns everything inside it.
  const printing = location.pathname.startsWith('/quote/')

  if (!session) return <SignIn />

  // A signed-in account with no shop is a fresh install, not an error.
  if (needsSetup) {
    return (
      <Setup
        fullName={
          (session.user.user_metadata?.full_name as string) ||
          session.user.email?.split('@')[0] ||
          'Owner'
        }
        onDone={refresh}
      />
    )
  }

  if (printing) {
    return (
      <Routes>
        <Route path="/quote/:quoteId/print" element={<QuoteDoc />} />
      </Routes>
    )
  }

  return (
    <>
      <TopBar ctx={ctx} />
      <main className="app-main">
        {ctxError ? (
          <div className="wrap">
            <div className="attn crit" style={{ marginTop: 16 }}>
              <b>Could not load the shop.</b>
              <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11 }}>{ctxError}</div>
            </div>
          </div>
        ) : !ctx ? (
          <div className="wrap" style={{ paddingTop: 24, color: 'var(--txt-3)', fontSize: 12 }}>
            Loading…
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/intake" replace />} />
            <Route path="/intake" element={<Intake ctx={ctx} />} />
            <Route path="/settings" element={<Settings ctx={ctx} onSaved={refresh} />} />
            <Route path="*" element={<Navigate to="/intake" replace />} />
          </Routes>
        )}
      </main>
    </>
  )
}

function TopBar({ ctx }: { ctx: ShopContext | null }) {
  const { pathname } = useLocation()
  const tab = (to: string, label: string) => (
    <Link
      to={to}
      className="tab"
      aria-selected={pathname.startsWith(to)}
      style={{ textDecoration: 'none', display: 'inline-block' }}
    >
      {label}
    </Link>
  )

  return (
    <header style={{ borderBottom: '1px solid var(--line)', background: 'var(--panel)' }}>
      <div className="wrap">
        <div className="topbar">
          <div className="brand" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="/brand/guma-mark.svg" alt="" width={26} height={24} style={{ display: 'block' }} />
            <div>
              <div className="mark">
                <b>Guma</b>
              </div>
              <div className="sub">{ctx?.shop.name ?? ''}</div>
            </div>
          </div>
          <div className="tabs" style={{ border: 'none' }}>
            {tab('/intake', 'Job intake')}
            {tab('/settings', 'Shop settings')}
          </div>
          <span className="who">
            <b>{ctx?.profile.full_name ?? ''}</b>
          </span>
          <button type="button" className="btn sm ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
