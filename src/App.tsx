import { lazy, startTransition, Suspense, useCallback, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { isTauri } from '@tauri-apps/api/core'
import { loadShopContext, NeedsSetup, type ShopContext } from './lib/data'
import { isDemo, switchWorkspace } from './lib/workspace'
import Wizard from './screens/Wizard'
import Settings from './screens/Settings'
import Intake from './screens/Intake'
import Dashboard from './screens/Dashboard'
import Projects from './screens/Projects'
import Project from './screens/Project'
import Clients from './screens/Clients'
import Series from './screens/Series'
import Shelf from './screens/Shelf'
import QuoteDoc from './screens/QuoteDoc'
import Closeout from './screens/Closeout'
import WelcomeModal from './components/WelcomeModal'
import { answersFrom, essentialsDone } from './lib/wizard'
import GlobalSearch from './components/GlobalSearch'

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
  /** Opened from the Guma menu, independent of show_welcome. */
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  /** "Finish later" on the setup guide. Session-only on purpose: the guide
   *  comes back next launch, because an unfinished shop is still reporting
   *  numbers it cannot support. */
  /**
   * "Finish later" used to last exactly one session -- useState, reset on
   * every launch -- so the wizard was the front door again the next time
   * the app opened, and the next, and the next. Reported as "I have to
   * answer the same questions over and over just to get to the projects
   * page", which is precisely what it did.
   *
   * It is now remembered. The banner on Projects still carries the unfinished
   * setup, so nothing is hidden; it just stops standing in the doorway.
   */
  const [setupDeferred, setSetupDeferred] = useState(() => {
    try {
      return localStorage.getItem('guma.setupDeferred') === '1'
    } catch {
      return false
    }
  })
  const location = useLocation()
  const navigate = useNavigate()
  /**
   * The setup wizard, once it is on screen, stays on screen until somebody
   * leaves it -- by an exit on the landing, "finish later", or a tab.
   *
   * Without this latch the wizard vanished out from under the person the
   * moment their last part-one answer saved: the gate flipped, App drew
   * the routes instead, and the landing -- "log my first job", "keep
   * setting up", "just look around" -- was never seen.
   */
  const [setupOpen, setSetupOpen] = useState(false)

  /**
   * Leaving setup has to actually leave.
   *
   * Setting the flag alone is not enough, because the wizard is reachable
   * two ways: as the front door at `/`, and as a route at `/setup-guide`
   * that the banner on Projects links to. From `/setup-guide`, deferring
   * dropped through to the router -- which rendered the wizard again, from
   * its own route. The button looked broken because from where somebody was
   * standing it was: they pressed "Just look around" and nothing moved.
   *
   * So leaving does both: stop blocking, and go to the work.
   */
  const leaveSetup = useCallback((to = '/projects') => {
    try {
      localStorage.setItem('guma.setupDeferred', '1')
    } catch {
      // Storage refused. The deferral still holds for this session, which
      // is no worse than it was before -- and better than refusing to
      // leave the wizard because a preference could not be written.
    }
    // ONE transition, not three updates. React Router 7 applies a
    // navigation inside startTransition, which is lower priority than a
    // plain setState. So closing the wizard committed first, the routes
    // rendered at the OLD address -- "/" on a first run -- and "/"
    // redirected to the dashboard before the navigation landed, throwing
    // it away. "Log my first job" created the job and showed the dashboard
    // instead. Putting the close inside the same transition as the
    // navigation makes them one render, at the new address.
    startTransition(() => {
      navigate(to)
      setSetupOpen(false)
      setSetupDeferred(true)
    })
  }, [navigate])

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

  /**
   * What forces the wizard open at launch: part one unanswered.
   *
   * It used to be the whole setup checklist, which included things no
   * question asked for and optional things a shop may rationally skip. So
   * a shop could answer everything, press the last button, and land back
   * in the wizard at launch forever. Part one is what the app cannot price
   * anything without; the rest is carried by the banner, not the doorway.
   */
  const mustSetup = !!ctx && !setupDeferred && !essentialsDone(answersFrom(ctx))
  useEffect(() => {
    if (mustSetup) setSetupOpen(true)
  }, [mustSetup])

  if (!ready) return null

  // The print view is its own full-bleed document: no app chrome, no dark
  // surface behind it. doc-page.js owns everything inside it.
  // Both printable documents live outside the app chrome: doc-page.js owns
  // everything inside them, down to the paper size.
  const printing =
    location.pathname.startsWith('/quote/') || location.pathname.endsWith('/closeout')

  if (!desktop && !session) {
    return (
      <Suspense fallback={null}>
        <SignIn />
      </Suspense>
    )
  }

  // A signed-in account (or, on desktop, a fresh install) with no shop yet
  // is a first run, not an error.
  const ownerName = desktop
    ? 'Owner'
    : (session?.user.user_metadata?.full_name as string) ||
      session?.user.email?.split('@')[0] ||
      'Owner'

  // A fresh install has no shop. The wizard creates one on the first answer
  // rather than at the end, so closing the window after naming the shop
  // leaves a shop with that name -- see screens/Wizard.tsx.
  if (needsSetup) {
    // The welcome comes FIRST, before a single question -- but ONLY here,
    // where there is no shop at all.
    //
    // A half-set-up shop deliberately does not get this (see
    // App.setup.render.test.tsx: two windows on launch is one too many, and
    // a wizard that asks for something beats a splash that describes the
    // app). That reasoning holds for somebody returning mid-setup. It does
    // not hold for somebody opening the program for the very first time,
    // who has no idea what it is yet -- and that person was the one case
    // the old `plan?.done` condition excluded entirely.
    //
    // It used to render only when `plan.done` -- once the shop was fully
    // configured -- which made it unreachable for the one person it was
    // written for. A new install opened straight onto a questionnaire, and
    // the "here is what this program is for" screen appeared eventually, to
    // somebody who by then had worked it out.
    return (
      <>
        <DemoRibbon />
        <WelcomeModal shop={null} onDismissedForever={refresh} />
        <Wizard ctx={null} fullName={ownerName} onSaved={refresh} />
      </>
    )
  }

  if (printing) {
    return (
      <Routes>
        <Route path="/quote/:quoteId/print" element={<QuoteDoc />} />
        <Route path="/project/:jobId/closeout" element={<Closeout />} />
      </Routes>
    )
  }

  /**
   * A shop that is not set up opens on setting itself up -- until part one
   * is answered (see mustSetup above). The rest of the checklist lives on
   * the banner on the Dashboard and Projects, which is where "finish
   * setting up" leads.
   */
  // Once the shop is actually configured the deferral has no job left, and
  // a stale flag would silently suppress the wizard for a shop that later
  // lost a rate or a machine.
  if (ctx && essentialsDone(answersFrom(ctx)) && setupDeferred) {
    try {
      localStorage.removeItem('guma.setupDeferred')
    } catch {
      /* nothing to do */
    }
  }

  if (ctx && (mustSetup || setupOpen)) {
    return (
      <>
        <WelcomeModal
          shop={ctx.shop}
          onDismissedForever={refresh}
          openNow={welcomeOpen}
          onClosed={() => setWelcomeOpen(false)}
          // Mounted but not opened: the wizard is the one window here.
          autoOpen={false}
        />
        <DemoRibbon />
        <TopBar
          ctx={ctx}
          desktop={desktop}
          onShowWelcome={() => setWelcomeOpen(true)}
          // Leaving for a screen means leaving the wizard, or nothing moves.
          onGo={(to) => leaveSetup(to)}
        />
        <main className="app-main">
          <Wizard
            ctx={ctx}
            fullName={ownerName}
            onSaved={refresh}
            onDefer={() => leaveSetup()}
            onLeave={(to) => leaveSetup(to)}
          />
        </main>
      </>
    )
  }

  return (
    <>
      {ctx && (
        <WelcomeModal
          shop={ctx.shop}
          onDismissedForever={refresh}
          openNow={welcomeOpen}
          onClosed={() => setWelcomeOpen(false)}
        />
      )}
      <DemoRibbon />
      <TopBar
        ctx={ctx}
        desktop={desktop}
        onShowWelcome={() => setWelcomeOpen(true)}
        onGo={(to) => navigate(to)}
      />
      <main className="app-main">
        {ctxError ? (
          <div className="wrap">
            <div className="attn crit" style={{ marginTop: 16 }}>
              <b>Could not load the shop.</b>
              <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11 }}>{ctxError}</div>
              {/* The way out, when the demo is what broke. The chosen
                  workspace is remembered across launches, so a demo that
                  cannot open is a demo the app reopens every time -- with
                  no route back to the real shop, because every route lives
                  behind the shop that failed to load. That is what "the app
                  is down" looked like. Your shop is a different file and was
                  never touched. */}
              {isDemo() && (
                <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6 }}>
                  This is the demo shop, which is a separate file — your own shop is untouched.
                  <div className="btnrow" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn sm primary"
                      onClick={() => switchWorkspace('shop')}
                    >
                      Back to my shop
                    </button>
                  </div>
                </div>
              )}
              {/* The one startup failure with a known, specific fix. Showing
                  the raw sqlx string and nothing else is how a two-minute
                  repair becomes a bug report. */}
              {/previously applied but has been modified/i.test(ctxError) && (
                <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6 }}>
                  A migration file changed after it had already been applied to this database.
                  Nothing is lost — run this in the project folder, then start the app again:
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      marginTop: 8,
                      padding: '8px 10px',
                      background: 'var(--panel-2)',
                      border: '1px solid var(--line)',
                      borderRadius: 'var(--radius)',
                      userSelect: 'all',
                    }}
                  >
                    npm run db:repair
                  </div>
                  <div style={{ marginTop: 8, color: 'var(--txt-3)' }}>
                    It backs the database up first, and prints what it changed. Add{' '}
                    <code>-- --dry-run</code> to see the plan without touching anything.
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : !ctx ? (
          <div className="wrap" style={{ paddingTop: 24, color: 'var(--txt-3)', fontSize: 12 }}>
            Loading…
          </div>
        ) : (
          <Routes>
            {/* Home is the work. A project-management tool that opens on an
                empty form is telling you its real subject is quoting. */}
            {/* Home is the dashboard: what the shop looks like right now,
                with every number linking to the screen that explains it.
                The board is one click away and is still where work gets
                moved -- this is the glance, not the workspace. */}
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard ctx={ctx} />} />
            <Route path="/intake" element={<Intake ctx={ctx} />} />
            <Route path="/projects" element={<Projects ctx={ctx} />} />
            {/* The two screens Projects absorbed. Kept as redirects so any
                link saved before the merge still lands somewhere real. */}
            <Route path="/pipeline" element={<Navigate to="/projects" replace />} />
            <Route path="/jobs" element={<Navigate to="/projects?view=list" replace />} />
            <Route path="/project/:jobId" element={<Project ctx={ctx} />} />
            <Route path="/clients" element={<Clients ctx={ctx} />} />
            <Route path="/series" element={<Series ctx={ctx} />} />
            <Route path="/series/:seriesId" element={<Series ctx={ctx} />} />
            <Route path="/shelf" element={<Shelf ctx={ctx} />} />
            <Route path="/settings" element={<Settings ctx={ctx} onSaved={refresh} />} />
            {/* Reachable any time, resuming wherever the shop left off. */}
            <Route
              path="/setup-guide"
              element={
                <Wizard
                  ctx={ctx}
                  fullName={ownerName}
                  onSaved={refresh}
                  // Reached on purpose from the banner, so leaving means
                  // going back to the work rather than falling through.
                  onDefer={() => leaveSetup()}
                  onLeave={(to) => leaveSetup(to)}
                />
              }
            />
            <Route path="*" element={<Navigate to="/projects" replace />} />
          </Routes>
        )}
      </main>
    </>
  )
}

/**
 * Who you are, and the handful of things that belong to "you" rather than
 * to a screen.
 *
 * This was a <span> containing the profile name -- which on desktop is the
 * literal word "Owner", because a local install has no account to take a
 * name from. It looked exactly like a control and was not one, so it read
 * as a broken tab. Either it does something or it should not look
 * clickable; this is the first option.
 *
 * "What Guma is" lives here on purpose. Whether the welcome appears on
 * launch depends on several conditions and has now been unreachable twice;
 * a door that depends on none of them means the answer to "why can I not
 * see it" is never again "work out which condition is false".
 */
/**
 * A strip across the top of every screen while the demo shop is open.
 *
 * Reported as "my saved data/project is missing now." It was not missing:
 * the app had reopened the DEMO, which is a separate, empty database file,
 * and an empty demo opens exactly the way a brand-new install does -- the
 * welcome, then the setup questions. From inside that, nothing said "this
 * is not your shop", and the first-run screens have no top bar, so the
 * only switch back lived behind a shop that did not exist yet.
 *
 * So the demo announces itself everywhere, including in the middle of the
 * setup wizard, and the way back is always one click. Your own shop is a
 * different file; nothing done here can reach it.
 */
function DemoRibbon() {
  if (!isDemo()) return null
  return (
    <div className="demoribbon" role="status">
      <span>
        <b>Demo shop.</b> Your own shop and projects are safe in a separate file — this is a
        sandbox.
      </span>
      <button type="button" className="btn sm primary" onClick={() => switchWorkspace('shop')}>
        Back to my shop
      </button>
    </div>
  )
}

/**
 * One step back, wherever you are.
 *
 * Deliberately history-based rather than a route: a fixed "up" target is a
 * guess about where the person came from, and it is wrong exactly when it
 * matters -- opening a project from a search, or landing on the closeout
 * from the project it belongs to.
 *
 * It hides when there is nothing sensible to go back to: on the dashboard
 * and the projects list (both home, in different senses) it would send
 * someone out of the app or into the loading screen they started on.
 */
function BackButton() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  if (pathname === '/' || pathname === '/dashboard' || pathname === '/projects') return null
  return (
    <button
      type="button"
      className="btn sm ghost"
      onClick={() => navigate(-1)}
      title="Back to where you were"
      style={{ whiteSpace: 'nowrap' }}
    >
      ← Back
    </button>
  )
}

function WhoMenu({
  ctx,
  onShowWelcome,
  onGo,
}: {
  ctx: ShopContext | null
  onShowWelcome: () => void
  onGo: (to: string) => void
}) {
  const [open, setOpen] = useState(false)
  const demo = isDemo()

  // Click anywhere else to close. A menu that only closes by clicking its
  // own button is a menu people leave open by accident.
  useEffect(() => {
    if (!open) return
    const shut = () => setOpen(false)
    window.addEventListener('click', shut)
    return () => window.removeEventListener('click', shut)
  }, [open])

  const item = (label: string, onClick: () => void) => (
    <button
      type="button"
      className="whoitem"
      onClick={() => {
        setOpen(false)
        onClick()
      }}
    >
      {label}
    </button>
  )

  return (
    <span className="whowrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="who"
        aria-haspopup="menu"
        aria-expanded={open}
        // The visible label is whoever this is, which on desktop is the
        // word "Owner" and elsewhere a real name. The accessible name says
        // what the control DOES, so it does not change with the fixture or
        // with who is signed in.
        aria-label={`${ctx?.profile.full_name ?? 'Owner'} — account menu`}
        onClick={() => setOpen((v) => !v)}
      >
        <b>{ctx?.profile.full_name ?? 'Owner'}</b>
        {demo && <span className="todo-chip">demo</span>}
        <span aria-hidden style={{ opacity: 0.6, marginLeft: 6 }}>▾</span>
      </button>
      {open && (
        <div className="whomenu" role="menu">
          <div className="whohead">
            {ctx?.shop.name ?? 'No shop yet'}
            <div className="whosub">
              {demo ? 'Demo shop — your real records are untouched' : 'Your shop'}
            </div>
          </div>
          {item('What Guma is', onShowWelcome)}
          {item('Shop settings', () => onGo('/settings'))}
          {item(demo ? 'Back to my shop' : 'Open the demo shop', () =>
            onGo('/settings?tab=workspace'),
          )}
        </div>
      )}
    </span>
  )
}

function TopBar({
  ctx,
  desktop,
  onShowWelcome,
  onGo,
}: {
  ctx: ShopContext | null
  desktop: boolean
  onShowWelcome: () => void
  /**
   * How to leave for another screen.
   *
   * In the main app this is plain navigation. Inside the wizard it has to
   * ALSO leave the wizard: that branch renders the wizard in place of the
   * routes, so navigating changed the URL and nothing on screen moved --
   * the menu opened, the item was clicked, and the wizard sat there. That
   * is the "options don't work" report.
   */
  onGo: (to: string) => void
}) {
  const { pathname } = useLocation()
  // A project detail page (/project/:id) belongs to the Projects tab —
  // without this, opening a project leaves the whole nav unlit, which reads
  // as "you have navigated out of the app" rather than "you are one level
  // down inside Projects".
  const owns = (to: string) =>
    pathname.startsWith(to) || (to === '/projects' && pathname.startsWith('/project/'))

  const tab = (to: string, label: string) => (
    <Link
      to={to}
      className="tab"
      aria-selected={owns(to)}
      style={{ textDecoration: 'none', display: 'inline-block' }}
    >
      {label}
    </Link>
  )

  return (
    <header style={{ borderBottom: '1px solid var(--line)', background: 'var(--panel)' }}>
      <div className="wrap">
        <div className="topbar">
          {/* The mark goes home. It was a <div>: the one thing every
              program has trained people to click when they want to get
              back, and it did nothing. */}
          <Link
            to="/dashboard"
            className="brand"
            aria-label="Guma — go to the dashboard"
            style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}
          >
            <img src="/brand/guma-mark.svg" alt="" width={26} height={24} style={{ display: 'block' }} />
            <div>
              <div className="mark">
                <b>Guma</b>
              </div>
              <div className="sub">
                {ctx?.shop.name ?? ''}
                {/* Which code is actually running. If this does not match
                    the commit you expect, you are looking at an old build
                    and editing source will not change it. */}
                <span
                  style={{ marginLeft: 8, opacity: 0.55, fontFamily: 'var(--mono)', fontSize: 10 }}
                  title={`Build ${__BUILD_STAMP__} · ${__BUILD_MODE__ === 'dev' ? 'dev server (live source)' : 'bundled build (frozen at build time)'}`}
                >
                  {__BUILD_MODE__ === 'dev' ? 'dev' : 'build'} {__BUILD_STAMP__}
                </span>
              </div>
            </div>
          </Link>
          {/* Back, everywhere. The project screen had a "← Projects" link
              and nothing else did, so Intake, Settings and the closeout
              were rooms with no door: the only way out was to pick a
              destination from the tabs, which is not the same as going
              back to what you were doing. History, not a fixed route --
              "back" has to mean back. Hidden on the two screens that are
              already home, where it would land on whatever came before
              the app. */}
          <BackButton />
          {/* Three places and one action. "New project" was a tab, which
              made a blank form the shop's home screen and put starting
              something on the same footing as looking at everything you
              have — a quoting app's shape, not a project manager's. It is a
              button now, and it is always one click away from wherever you
              are. */}
          <div className="tabs" style={{ border: 'none' }}>
            {tab('/dashboard', 'Dashboard')}
            {tab('/projects', 'Projects')}
            {tab('/clients', 'Clients')}
            {/* The shop's own work, held the way Clients holds theirs. */}
            {tab('/series', 'Series')}
            {/* The other half of the business. A shop selling at a market or
                on Etsy does work nobody commissioned, and until this tab
                existed none of it was anywhere in the program. */}
            {tab('/shelf', 'Shelf')}
            {tab('/settings', 'Shop settings')}
          </div>
          {/* Search sits between the tabs and the action, because it is
              neither: the tabs are where you go when you do not know what
              you are looking for, and this is where you go when you do. */}
          {ctx && <GlobalSearch ctx={ctx} />}
          <Link
            to="/intake"
            className="btn primary sm"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}
          >
            + New project
          </Link>
          <WhoMenu ctx={ctx} onShowWelcome={onShowWelcome} onGo={onGo} />
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
