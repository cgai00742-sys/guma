// @vitest-environment jsdom
/**
 * The program opens on setting the shop up.
 *
 * This file exists because the guide was built, routed, and then never
 * opened: `/` navigated to `/projects` unconditionally, so a screen that
 * worked perfectly was unreachable unless you knew its URL. Everything
 * passed. Nothing was wrong except the one thing that mattered.
 *
 * So the assertion is deliberately about LAUNCH, not about the component:
 * render the app with an unfinished shop and the guide has to be the thing
 * on screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { makeCtx, makeRateCard, makeShop, PRINTER_ROW } from './lib/fixtures'
import type { ShopContext } from './lib/data.types'

let ctx: ShopContext = makeCtx()

const loadShopContext = vi.fn(async () => ctx)
const saveRateCard = vi.fn(async () => {})
vi.mock('./lib/data', async () => {
  const types = await import('./lib/data.types')
  return {
    ...types,
    loadShopContext,
    listJobs: vi.fn(async () => []),
    listGuideSeen: vi.fn(async () => []),
    markGuideSeen: vi.fn(async () => {}),
    dismissWelcome: vi.fn(async () => {}),
    saveShopIdentity: vi.fn(async () => {}),
    saveShopQuoteTerms: vi.fn(async () => {}),
    saveRateCard,
    savePrinter: vi.fn(async () => {}),
    saveMaterial: vi.fn(async () => {}),
    listShelf: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    listSales: vi.fn(async () => []),
  }
})
// The app decides it is a desktop build by asking Tauri, and NeedsSetup is
// the sentinel it checks loadShopContext's rejection against.
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

/** jsdom has no showModal; see Jobs.guide.render.test.tsx for the detail. */
function polyfillDialog() {
  const proto = window.HTMLDialogElement?.prototype
  if (!proto) return
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  proto.close = function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
}

/**
 * `firstRun` makes loadShopContext reject with NeedsSetup -- no shop row at
 * all.
 *
 * It has to happen AFTER vi.resetModules(), and that is the whole reason
 * this is a parameter rather than two lines in the test. App.tsx checks
 * `e instanceof NeedsSetup`; resetModules gives every later import a fresh
 * module instance with a fresh class object, so a NeedsSetup constructed
 * from an import taken beforehand is a different class and the instanceof
 * quietly fails. The app then treats a first launch as an unknown error.
 */
async function renderApp(at = '/', { firstRun = false } = {}) {
  vi.resetModules()
  if (firstRun) {
    // From './lib/data' -- the SAME specifier App.tsx imports it from, so
    // the class object is identical. Importing it from './lib/data.types'
    // instead yields a different class after vi.resetModules(), the app's
    // `e instanceof NeedsSetup` is false, and a first launch is reported as
    // "Could not load the shop" instead of opening the wizard.
    const { NeedsSetup } = (await import('./lib/data')) as unknown as {
      NeedsSetup: new (m: string) => Error
    }
    // mockImplementation, NOT mockRejectedValueOnce.
    //
    // A queued "once" is consumed by whichever call arrives first, and the
    // previous test's render can still have a loadShopContext in flight
    // when this one sets it up -- cleanup() unmounts the tree but does not
    // cancel a promise already on its way. The rejection then lands on the
    // wrong test and this one gets the ordinary context, which is why this
    // passed alone and failed in sequence. A plain implementation has no
    // queue to steal.
    loadShopContext.mockImplementation(async () => {
      throw new NeedsSetup('no shop yet')
    })
  } else {
    loadShopContext.mockImplementation(async () => ctx)
  }
  const { default: App } = await import('./App')
  const { MemoryRouter } = await import('react-router-dom')
  render(
    <MemoryRouter initialEntries={[at]}>
      <App />
    </MemoryRouter>,
  )
}

/**
 * Wait for the welcome to be on screen.
 *
 * waitFor rather than findByText: the first launch reaches this through a
 * rejected promise and two state updates, and findByText's observer does
 * not reliably see the result of that inside its window -- it failed at
 * exactly its 1s timeout while a 50ms settle made it pass every time, which
 * is the signature of a query that is not polling rather than a render that
 * is slow. waitFor polls, which is also what the rest of this file does.
 */
const welcomed = () =>
  waitFor(() => expect(screen.getByText(/Welcome to Guma/i)).toBeDefined())

/** Next when the question is answered, Skip for now when it is not. */
const goOn = (u: ReturnType<typeof userEvent.setup>) =>
  u.click(screen.getByRole('button', { name: /^(next|skip for now)$/i }))

/** Move forward until the wizard asks this, or give up loudly. */
async function walkTo(u: ReturnType<typeof userEvent.setup>, want: RegExp) {
  for (let i = 0; i < 10; i += 1) {
    const asked = screen.queryByRole('heading', { level: 2 })?.textContent ?? ''
    if (want.test(asked)) return
    await goOn(u)
    await waitFor(() => expect(document.body.textContent).toBeTruthy())
  }
  throw new Error(`the wizard never asked ${want}`)
}

/** A shop that exists but cannot price anything honestly yet. */
const halfSetUp = (): ShopContext => ({
  ...makeCtx(),
  shop: makeShop({ electricity_rate_kwh: null }),
  rateCard: makeRateCard({ design_hourly: 0, finishing_hourly: 0 }),
  printerRows: [{ ...PRINTER_ROW, watts: null }],
})

beforeEach(() => {
  cleanup()
  polyfillDialog()
  vi.clearAllMocks()
  // clearAllMocks wipes call history but leaves implementations, so the
  // first-run override above would otherwise persist into the next test.
  loadShopContext.mockImplementation(async () => ctx)
  // "Finish later" is remembered in localStorage now, and jsdom keeps that
  // between tests in a file. Without this, the first test that defers
  // suppresses the wizard for every test after it -- which is exactly the
  // feature working, leaking into the harness.
  try {
    localStorage.clear()
  } catch {
    /* no storage, nothing to clear */
  }
})

describe('launching an unfinished shop', () => {
  it('opens on the wizard, not on the project board', async () => {
    ctx = halfSetUp()
    await renderApp()
    // The regression this file was written for: the wizard existed, was
    // routed, and nothing ever opened it.
    expect(await screen.findByText('Setting up')).toBeDefined()
    // A question, not a form. See src/lib/wizard.ts.
    expect(document.body.textContent).toMatch(/\?/)
  })

  it('does not stack the welcome splash on top of it', async () => {
    // Two windows on launch is one too many, and the guide is the better
    // of the two: it asks for something rather than describing the app.
    ctx = halfSetUp()
    await renderApp()
    await screen.findByText('Setting up')
    expect(screen.queryByText(/Price a project honestly/i)).toBeNull()
  })

  it('resumes on the first question that is not answered', async () => {
    ctx = halfSetUp()
    await renderApp()
    await screen.findByText('Setting up')
    // Name and place are answered in the fixture; the power rate is the
    // first real gap, so that is the question it opens on rather than
    // walking somebody back through what they already told it.
    expect(await screen.findByText(/What do you pay for electricity/i)).toBeDefined()
  })

  it('lets somebody through without finishing, and says what it costs', async () => {
    ctx = halfSetUp()
    const user = userEvent.setup()
    await renderApp()
    await screen.findByText(/Setting up/i)

    await user.click(screen.getByRole('button', { name: /finish later/i }))
    // Through to the app proper, with the gap carried on a banner rather
    // than silently forgotten.
    await waitFor(() => expect(screen.queryByText('Setting up')).toBeNull())
    // The gap follows you onto the board rather than being forgotten.
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/not right yet|configured/i),
    )
  })
})

describe('launching a shop that is actually finished', () => {
  it('goes straight to the work', async () => {
    ctx = makeCtx()
    await renderApp()
    await waitFor(() => expect(loadShopContext).toHaveBeenCalled())
    expect(screen.queryByText('Setting up')).toBeNull()
  })
})

describe('leaving the wizard', () => {
  /**
   * "Just look around" did nothing, and it was not the button's fault.
   *
   * The wizard is reachable two ways: as the front door at `/`, and as a
   * route at `/setup-guide` that the banner on Projects links to. Deferring
   * only set a flag, so from `/setup-guide` the app stopped blocking and
   * then rendered the wizard again -- from its own route. Every one of
   * these asserts from a starting path, because the path was the bug.
   */
  it('gets out from the front door', async () => {
    ctx = halfSetUp()
    const user = userEvent.setup()
    await renderApp('/')
    await screen.findByText('Setting up')

    await user.click(screen.getByRole('button', { name: /finish later/i }))
    await waitFor(() => expect(screen.queryByText('Setting up')).toBeNull())
  })

  it('gets out from the banner route, where it used to sit still', async () => {
    ctx = halfSetUp()
    const user = userEvent.setup()
    await renderApp('/setup-guide')
    await screen.findByText('Setting up')

    await user.click(screen.getByRole('button', { name: /finish later/i }))
    await waitFor(() => expect(screen.queryByText('Setting up')).toBeNull())
    // Landed on the work, not on a blank screen.
    await waitFor(() => expect(document.body.textContent).toMatch(/not right yet|configured/i))
  })

  it('gets out from the landing at the end of part one', async () => {
    // The screen somebody actually reaches: seven questions, then three
    // buttons, one of which says it will let you look around.
    ctx = halfSetUp()
    const user = userEvent.setup()
    await renderApp('/setup-guide')
    await screen.findByText('Setting up')

    for (let i = 0; i < 10; i += 1) {
      if (screen.queryByRole('button', { name: /just look around/i })) break
      await goOn(user)
      await waitFor(() => expect(document.body.textContent).toBeTruthy())
    }
    await user.click(screen.getByRole('button', { name: /just look around/i }))
    await waitFor(() => expect(screen.queryByText(/Picked up where you left it/i)).toBeNull())
    await waitFor(() => expect(document.body.textContent).toMatch(/not right yet|configured/i))
  })
})

describe('the rate question', () => {
  it('sends what was typed', async () => {
    // Where this one actually broke was the read, not the write -- see
    // rateCards.test.ts. This is the other half of the pair: proof that the
    // screen sends the number, so a future failure has only one place left
    // to hide.
    ctx = halfSetUp()
    const user = userEvent.setup()
    await renderApp('/')
    await screen.findByText('Setting up')

    await walkTo(user, /hour of your time worth/i)
    const box = document.getElementById('w-designHourly') as HTMLInputElement
    await user.clear(box)
    await user.type(box, '65')
    await goOn(user)

    await waitFor(() => expect(saveRateCard).toHaveBeenCalled())
    const [, card] = saveRateCard.mock.calls[0] as unknown as [string, { design_hourly: number }]
    expect(card.design_hourly).toBe(65)
  })
})

describe('the other half of the business', () => {
  it('has a tab of its own, and it opens', async () => {
    // A shop selling at a market does work nobody commissioned, and until
    // the Shelf existed none of it was anywhere in the program. A screen
    // that is routed but not reachable is the exact failure this file was
    // written for the first time.
    ctx = makeCtx()
    const user = userEvent.setup()
    await renderApp('/')
    await waitFor(() => expect(loadShopContext).toHaveBeenCalled())

    await user.click(await screen.findByRole('link', { name: 'Shelf' }))
    expect(await screen.findByRole('heading', { name: 'Shelf' })).toBeDefined()
  })
})

/* ---- the front door ------------------------------------------------------ */

/**
 * The welcome has to be the FIRST thing, and it never was.
 *
 * App.tsx rendered it behind `plan?.done` -- only once the shop was fully
 * configured. So the screen whose entire job is telling a new person what
 * this program is for was shown exclusively to people who had already
 * finished setting it up and no longer needed telling. Reported three times
 * as "I've yet to see the animation", and correctly: it was unreachable.
 *
 * These assert the ORDER of a first launch, which is the thing that was
 * wrong. No test could have caught it before, because every test rendered a
 * fully set-up shop.
 */
describe('what a brand new install shows first', () => {
  it('welcomes before it asks anything', async () => {
    await renderApp('/', { firstRun: true })
    await welcomed()
    // And actually open, not merely mounted somewhere behind things.
    expect(document.querySelector('dialog')?.open).toBe(true)
  })

  it('offers no "don\'t show again" when there is no shop to remember it', async () => {
    await renderApp('/', { firstRun: true })
    await welcomed()

    // Offering a checkbox that silently cannot be saved is worse than not
    // offering one. It says what happens next instead.
    expect(screen.queryByLabelText(/don.t show this again/i)).toBeNull()
    expect(screen.getByRole('button', { name: /set up my shop/i })).toBeDefined()
  })

  it('does NOT stack on a half-set-up shop, which is a different case', async () => {
    // The standing decision (above): two windows on launch is one too many,
    // and a wizard that asks for something beats a splash that describes
    // the app. That holds for somebody returning mid-setup. It is only the
    // true first launch, with no shop at all, that leads with the welcome.
    ctx = halfSetUp()
    await renderApp()
    await screen.findByText('Setting up')
    expect(screen.queryByText(/Price a project honestly/i)).toBeNull()
  })

  it('carries the motion classes the stylesheet animates', async () => {
    await renderApp('/', { firstRun: true })
    await welcomed()
    // guma.css §8.5 staggers these. If the markup stops carrying them the
    // animation silently stops happening and nothing else notices.
    for (const cls of ['wmark', 'wtitle', 'wlede', 'wpoint', 'wfoot'])
      expect(document.querySelector(`.${cls}`)).not.toBeNull()
  })
})

describe('finishing setup later', () => {
  it('remembers the deferral across a relaunch', async () => {
    ctx = halfSetUp()
    const u = userEvent.setup()
    await renderApp()
    await screen.findByText('Setting up')

    await u.click(screen.getByRole('button', { name: /finish later/i }))
    await waitFor(() => expect(localStorage.getItem('guma.setupDeferred')).toBe('1'))

    // Relaunch. The wizard used to be the front door again, every time --
    // "I have to answer the same questions over and over".
    cleanup()
    await renderApp()
    await waitFor(() => expect(screen.queryByText('Setting up')).toBeNull())
  })
})

/* ---- the top bar --------------------------------------------------------- */

/**
 * Two things that looked like controls and were not.
 *
 * "Owner" was a <span> holding the profile name -- which on a desktop
 * install is the literal word "Owner", since there is no account to take a
 * name from. It sat in the row of tabs, looked exactly like one, and did
 * nothing. The Guma mark was a <div>: the one element every program has
 * trained people to click to get home, and it was inert.
 */
describe('the top bar', () => {
  it('takes the mark home', async () => {
    ctx = makeCtx()
    await renderApp('/settings')
    const home = await screen.findByLabelText(/go to Projects/i)
    expect(home.getAttribute('href')).toBe('/projects')
  })

  it('opens a real menu behind the name, not a dead label', async () => {
    ctx = makeCtx()
    const u = userEvent.setup()
    await renderApp()
    const who = await screen.findByRole('button', { name: /account menu/i })
    expect(who.getAttribute('aria-expanded')).toBe('false')

    await u.click(who)
    expect(who.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu')).toBeDefined()
  })

  it('can open the welcome on demand, whatever show_welcome says', async () => {
    // The condition that hid it: a shop that has already dismissed it.
    ctx = { ...makeCtx(), shop: makeShop({ show_welcome: false }) }
    const u = userEvent.setup()
    await renderApp()
    await screen.findByRole('button', { name: /account menu/i })

    // Not SHOWING, correctly -- it was dismissed. The markup is always in
    // the DOM inside a closed <dialog>, so `open` is the thing to assert;
    // queryByText finds text inside a closed dialog quite happily.
    expect(document.querySelector('dialog')?.open).toBeFalsy()

    await u.click(screen.getByRole('button', { name: /account menu/i }))
    await u.click(screen.getByRole('button', { name: /what guma is/i }))

    // And now it is, without changing that setting. This is the door that
    // does not depend on any of the launch conditions -- the ones that have
    // made this screen unreachable twice.
    await waitFor(() => expect(document.querySelector('dialog')?.open).toBe(true))
    expect(screen.getByText(/Price a project honestly/i)).toBeDefined()
  })

  it('still carries the motion classes when opened that way', async () => {
    ctx = { ...makeCtx(), shop: makeShop({ show_welcome: false }) }
    const u = userEvent.setup()
    await renderApp()
    await u.click(await screen.findByRole('button', { name: /account menu/i }))
    await u.click(screen.getByRole('button', { name: /what guma is/i }))
    await welcomed()
    for (const cls of ['wmark', 'wtitle', 'wlede', 'wpoint', 'wfoot'])
      expect(document.querySelector(`.${cls}`)).not.toBeNull()
  })
})
