// @vitest-environment jsdom
/**
 * The setup wizard, actually rendered.
 *
 * Every one of this project's worst bugs so far has been of the same kind: a
 * screen that typechecks, passes its logic tests, and is broken the moment a
 * person looks at it. A gate with no control to clear it. A form with no way
 * out. A dropdown of fifty US states shown to a shop in Lyon. None of those
 * are visible to a test that never renders anything, which is why this file
 * exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const setupShop = vi.fn(async (_payload: any) => 'shop-1')
vi.mock('../lib/data', () => ({ setupShop }))

/** jsdom reports the machine's locale through navigator.language, which is
 *  exactly what src/lib/locale.ts reads. Pretending to be elsewhere is
 *  therefore a one-line change, not a mock of our own code. */
function pretendMachineIsIn(tag: string) {
  Object.defineProperty(window.navigator, 'language', { value: tag, configurable: true })
  Object.defineProperty(window.navigator, 'languages', { value: [tag], configurable: true })
}

async function renderWizard(tag: string) {
  pretendMachineIsIn(tag)
  vi.resetModules()
  const { default: Setup } = await import('./Setup')
  render(<Setup onDone={() => {}} fullName="Anke Roth" />)
}

beforeEach(() => {
  cleanup()
  setupShop.mockClear()
})

describe('the setup wizard on a machine in the United States', () => {
  it('offers the state dropdown, because the tax-name hint needs it', async () => {
    await renderWizard('en-US')
    expect(screen.getByLabelText('State')).toBeDefined()
  })

  it('guesses dollars, and says so in the sample', async () => {
    await renderWizard('en-US')
    const cur = screen.getByLabelText('Currency') as HTMLSelectElement
    expect(cur.value).toBe('USD')
    expect(screen.getByText(/Sample:/).textContent).toContain('$')
  })
})

describe('the setup wizard on a machine that is not in the United States', () => {
  it('does not show a US state dropdown at all', async () => {
    await renderWizard('de-DE')
    expect(screen.queryByLabelText('State')).toBeNull()
    // and not merely hidden -- the fifty option elements should not exist
    expect(screen.queryByText('Hawaii')).toBeNull()
  })

  it('says what it picked up from the machine instead of asking', async () => {
    await renderWizard('de-DE')
    const formats = screen.getByText(/Numbers, dates and page size follow this computer/)
    expect(formats.textContent).toContain('de-DE')
    expect(formats.textContent).toContain('A4')
  })

  it('guesses the local currency and formats the sample the local way', async () => {
    await renderWizard('de-DE')
    const cur = screen.getByLabelText('Currency') as HTMLSelectElement
    expect(cur.value).toBe('EUR')
    const sample = screen.getByText(/Sample:/).textContent ?? ''
    expect(sample).toContain('€')
    // German grouping: 1.234,50 -- the bug this guards is a euro amount
    // printed with US separators.
    expect(sample).toContain('1.234,50')
  })

  it('offers far more than the ten currencies the old list shipped', async () => {
    await renderWizard('en-GB')
    const cur = screen.getByLabelText('Currency') as HTMLSelectElement
    expect(cur.options.length).toBeGreaterThan(100)
    const codes = Array.from(cur.options).map((o) => o.value)
    expect(codes).toContain('NGN')
    expect(codes).toContain('KES')
    expect(codes).toContain('IDR')
  })

  it('labels the electricity rate in the shop currency, not dollars', async () => {
    await renderWizard('de-DE')
    expect(screen.getByLabelText(/electricity rate/i)).toBeDefined()
    expect(screen.getByText(/Your electricity rate, €\/kWh/)).toBeDefined()
  })
})

describe('what the wizard insists on', () => {
  it('blocks the first step until the shop has a name, and says why', async () => {
    await renderWizard('en-GB')
    const user = userEvent.setup()
    const next = screen.getByRole('button', { name: /continue/i })
    expect((next as HTMLButtonElement).disabled).toBe(true)

    await user.type(screen.getByLabelText(/Shop name/), 'Werkstatt Drei')
    expect((screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('sends the machine locale and derived paper size through to setup', async () => {
    await renderWizard('de-DE')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/Shop name/), 'Werkstatt Drei')
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /create my shop/i }))

    expect(setupShop).toHaveBeenCalledTimes(1)
    const payload = setupShop.mock.calls[0]![0] as any
    expect(payload.shop.locale).toBe('de-DE')
    expect(payload.shop.currency).toBe('EUR')
    expect(payload.shop.paper).toBe('a4')
    // A shop outside the US never sends a state, even a stale one.
    expect(payload.shop.state).toBe('')
  })
})

describe('nothing on this screen recommends a price', () => {
  it('leaves every rate input empty rather than pre-filling someone else’s numbers', async () => {
    await renderWizard('en-GB')
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/Shop name/), 'A Shop')
    await user.click(screen.getByRole('button', { name: /continue/i }))

    for (const label of [/design/i, /finishing/i, /minimum/i]) {
      const input = screen.getByLabelText(label) as HTMLInputElement
      expect(input.value).toBe('')
    }
  })
})
