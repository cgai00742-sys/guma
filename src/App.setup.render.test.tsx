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

async function renderApp(at = '/') {
  vi.resetModules()
  const { default: App } = await import('./App')
  const { MemoryRouter } = await import('react-router-dom')
  render(
    <MemoryRouter initialEntries={[at]}>
      <App />
    </MemoryRouter>,
  )
}

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
