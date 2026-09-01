import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { isTauri } from '@tauri-apps/api/core'
import { loadShopContext, NeedsSetup, type ShopContext } from './lib/data'
import Setup from './screens/Setup'
import Settings from './screens/Settings'
import Intake from './screens/Intake'
import QuoteDoc from './screens/QuoteDoc'

// SignIn is the ONE screen that still statically imports supabase.ts (it
// calls signInWithPassword/signInWithOtp directly). A desktop build never
// renders it, but a plain top-level `import SignIn from './screens/SignIn'`
// would still pull supabase.ts's throw-on-missing-env-vars code into the
// same eagerly-evaluated bundle as this file, defeating the whole point of
// the isTauri() branch below. Loading it with React.lazy keeps it — and
// supabase.ts — out of that eager chunk; the desktop app never fetches or
// evaluates either.
const SignIn = lazy(() => import('./screens/SignIn'))

export default function App() {
  // Desktop builds have no accounts and no sign-in — one install is one
  // shop. Computed once per render rather than stored in state: isTauri()
  // is a cheap, side-effect-free runtime check (see data.ts for the same
  // pattern), so there's no reason to let it drift across renders.
  //
  // `./lib/supabase` is only ever reached through a dynamic import below,
  // never a top-level one — a static import would evaluate supabase.ts
  // (which throws if its env vars are missing) on every load of this file,
  // including inside the desktop app, which is exactly the situation this
  // guards against once the desktop build stops carrying Supabase secrets.
  const desktop = isTauri()

  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [ctx, setCtx] = useState<ShopContext | null>(null)
  const [ctxError, setCtxError] = useState<string | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const location = useLocation()

  useEffect(() => {
    if (desktop) {
      // No account, so nothing to load — go straight to loading the shop.
      setReady(true)
      return
    }
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    import('./lib/supabase').then(({ supabase }) => {
      if (cancelled) return
      supabase.auth.getSession().then(({ data }) => {
        if (cancelled) return
        setSession(data.session)
        setReady(true)
      })
      const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
      unsubscribe = () => sub.subscription.unsubscribe()
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [desktop])

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
    if (desktop || session) void refresh()
    else setCtx(null)
  }, [desktop, session, refresh])

  if (!ready) return null

  // The print view is its own full-bleed document: no app chrome, no dark
  // surface behind it. doc-page.js owns everything inside it.
  const printing = location.pathname.startsWith('/quote/')

  if (!desktop && !session) {
    return (
      <Suspense fallback={null}>
        <SignIn />
      </Suspense>
    )
  }

  // A signed-in account (or, on desktop, a fresh install) with no shop yet
  // is a first run, not an error.
  if (needsSetup) {
    return (
      <Setup
        fullName={
          desktop
            ? 'Owner'
            : (session!.user.user_metadata?.full_name as string) ||
              session!.user.email?.split('@')[0] ||
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
      <TopBar ctx={ctx} desktop={desktop} />
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

function TopBar({ ctx, desktop }: { ctx: ShopContext | null; desktop: boolean }) {
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
          {/* No account on desktop, so nothing to sign out of. */}
          {!desktop && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                void import('./lib/supabase').then(({ supabase }) => supabase.auth.signOut())
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
