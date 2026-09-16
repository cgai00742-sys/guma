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
    saveRateCard: vi.fn(async () => {}),
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

async function renderApp() {
  vi.resetModules()
  const { default: App } = await import('./App')
  const { MemoryRouter } = await import('react-router-dom')
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  )
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
  it('opens on the setup guide, not on the project board', async () => {
    ctx = halfSetUp()
    await renderApp()
    // The regression this file was written for.
    expect(await screen.findByText(/Setting up/i)).toBeDefined()
    expect(screen.getByText(/saves as you go/i)).toBeDefined()
  })

  it('does not stack the welcome splash on top of it', async () => {
    // Two windows on launch is one too many, and the guide is the better
    // of the two: it asks for something rather than describing the app.
    ctx = halfSetUp()
    await renderApp()
    await screen.findByText(/Setting up/i)
    expect(screen.queryByText(/Price a project honestly/i)).toBeNull()
  })

  it('starts on the first thing that is not answered', async () => {
    ctx = halfSetUp()
    await renderApp()
    await screen.findByText(/Setting up/i)
    // Identity and place are filled in the fixture; power is the first gap.
    expect(await screen.findByText(/What do you pay per kWh/i)).toBeDefined()
  })

  it('lets somebody through without finishing, and says what it costs', async () => {
    ctx = halfSetUp()
    const user = userEvent.setup()
    await renderApp()
    await screen.findByText(/Setting up/i)

    await user.click(screen.getByRole('button', { name: /finish later/i }))
    // Through to the app proper, with the gap carried on a banner rather
    // than silently forgotten.
    await waitFor(() => expect(screen.queryByText(/saves as you go/i)).toBeNull())
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
    expect(screen.queryByText(/saves as you go/i)).toBeNull()
  })
})
