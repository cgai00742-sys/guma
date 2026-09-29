// @vitest-environment jsdom
/**
 * The wizard, actually walked.
 *
 * Both of the bugs this file was written after were the same shape: a
 * payload whose keys did not match the type it was being passed as, hidden
 * by an `as never` cast, failing at the database on a screen a person was
 * looking at. Neither was catchable by reading the code, and neither was
 * caught by 415 tests, because nothing walked the wizard and checked what
 * it SENT.
 *
 *   NOT NULL constraint failed: rate_cards.design_hourly
 *   NOT NULL constraint failed: materials.cost_per_unit
 *
 * So these assertions are about the shape of what leaves the screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { partOne } from '../lib/wizard'

const setupShop = vi.fn(async (_payload: unknown) => 'shop-new')
const saveShopIdentity = vi.fn(async () => {})
const savePrinter = vi.fn(async () => {})
const saveMaterial = vi.fn(async (_shopId: string, _input: Record<string, unknown>) => {})
const saveRateCard = vi.fn(async () => {})
const saveShopQuoteTerms = vi.fn(async () => {})
const createInHouseJob = vi.fn(async () => 'job-1')
const listChannels = vi.fn(async () => [])
const saveChannel = vi.fn(async (_shopId: string, _input: Record<string, unknown>) => ({
  id: 'ch-1', name: 'Etsy', fee_pct: 9.5, fee_flat: 0.45, archived: 0,
}))

const saveSellBranch = vi.fn(async () => {})
vi.mock('../lib/data', async () => {
  const types = await import('../lib/data.types')
  return {
    ...types,
    setupShop, saveShopIdentity, savePrinter, saveMaterial, saveRateCard,
    saveShopQuoteTerms, createInHouseJob, listChannels, saveChannel, saveSellBranch,
  }
})

async function renderWizard(ctx: unknown = null) {
  vi.resetModules()
  const { default: Wizard } = await import('./Wizard')
  const { makeCtx } = await import('../lib/fixtures')
  render(
    <MemoryRouter>
      <Wizard
        ctx={ctx === 'full' ? makeCtx() : null}
        fullName="Owner"
        onSaved={() => {}}
      />
    </MemoryRouter>,
  )
}

/** The question on screen, in its own words. */
const asked = () => screen.getByRole('heading', { level: 2 }).textContent ?? ''

/**
 * Fill fields by their answer key rather than by role.
 *
 * Roles are the wrong handle here: a question can be one text box, two
 * number boxes, or a box and a select, and `getAllByRole('spinbutton')`
 * throws outright on a question that has no number field. The key is what
 * the script itself uses, and QuestionField renders it as `w-<key>`.
 */
async function fill(
  user: ReturnType<typeof userEvent.setup>,
  values: Record<string, string>,
) {
  for (const [key, v] of Object.entries(values)) {
    const el = document.getElementById(`w-${key}`) as HTMLInputElement | HTMLSelectElement | null
    if (!el) throw new Error(`no field w-${key} on "${asked()}"`)
    if (el.tagName === 'SELECT') await user.selectOptions(el, v)
    else {
      await user.clear(el)
      await user.type(el, v)
    }
  }
}

/** Next when answered, Skip for now when not -- the same button either way. */
const goOn = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /^(next|skip for now)$/i }))

/** Skip forward until the question asked matches. */
async function walkTo(user: ReturnType<typeof userEvent.setup>, want: RegExp) {
  for (let i = 0; i < 10; i += 1) {
    if (want.test(asked())) return
    await goOn(user)
    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toBeDefined())
  }
  throw new Error(`never reached ${want}; stopped on "${asked()}"`)
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the shop is created on the first answer', () => {
  it('creates it from just a name, so closing the window loses nothing', async () => {
    const user = userEvent.setup()
    await renderWizard()
    await screen.findByText('What is your shop called?')

    await fill(user, { name: 'Guma Creations' })
    await goOn(user)
    await waitFor(() => expect(setupShop).toHaveBeenCalledTimes(1))

    // Rates are not asked about for another six questions, so the payload
    // that creates the shop has none. data.ts fills them in.
    const payload = setupShop.mock.calls[0]![0] as { shop: { name: string } }
    expect(payload.shop.name).toBe('Guma Creations')
    await waitFor(() => expect(asked()).toMatch(/Where do you work from/))
  })
})

describe('what the material question sends', () => {
  it('uses the keys MaterialInput actually has', async () => {
    // The bug: the payload was written in snake_case (cost_per_unit), which
    // MaterialInput does not have, so undefined reached a NOT NULL column.
    // An `as never` cast is what let it compile.
    const user = userEvent.setup()
    await renderWizard()
    await screen.findByText('What is your shop called?')

    await fill(user, { name: 'Guma Creations' })
    await walkTo(user, /print with most/i)

    await fill(user, { mName: 'PETG', mPerKg: '22' })
    await goOn(user)
    await waitFor(() => expect(saveMaterial).toHaveBeenCalled())

    const [, input] = saveMaterial.mock.calls[0]!
    expect(Object.keys(input)).toContain('costPerUnit')
    expect(Object.keys(input)).not.toContain('cost_per_unit')
    // Asked per kilo, stored per gram.
    expect(input.costPerUnit).toBeCloseTo(0.022, 6)
    expect(input.sellOverride).toBeNull()
    // Every NOT NULL column on materials has a real value.
    for (const key of ['name', 'kind', 'swatch', 'unit', 'costPerUnit', 'onHand', 'reorderAt']) {
      expect(input[key], `${key} would hit the database as null`).not.toBeUndefined()
    }
    // A brand-new machine has no id: PrinterInput makes it optional, and
    // passing null asks the backend to update the row with id null.
    expect(Object.keys(input)).not.toContain('id')
  })
})

describe('a question can always be skipped', () => {
  it('offers Skip for now rather than a disabled Next', async () => {
    // Somebody whose electricity bill is in a drawer should move on and
    // come back, not invent a number to get past the screen. An invented
    // number looks answered forever.
    const user = userEvent.setup()
    await renderWizard()
    await screen.findByText('What is your shop called?')

    const btn = screen.getByRole('button', { name: /skip for now/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    await fill(user, { name: 'Guma' })
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: /skip for now/i })).toBeNull()
  })

  it('still lands after the last question when things were skipped', async () => {
    const user = userEvent.setup()
    await renderWizard()
    await screen.findByText('What is your shop called?')

    await fill(user, { name: 'Guma Creations' })
    // Answer one, skip the other six, and the seventh click is the one that
    // has to land rather than walk on into part two.
    for (let i = 0; i < partOne().length; i += 1) {
      await goOn(user)
      await waitFor(() => expect(document.querySelector('.pane')).toBeDefined())
    }

    // The landing tells the truth rather than claiming readiness.
    expect(await screen.findByText(/Picked up where you left it/i)).toBeDefined()
    expect(screen.getByText(/will read low until they are answered/i)).toBeDefined()
    // And names what is still open, so it is not a mystery later.
    expect(screen.getByText(/What do you pay for electricity/)).toBeDefined()
  })
})

describe('where you sell', () => {
  it('creates the channels, with Etsy at its published cut', async () => {
    /**
     * The wizard asked this question and threw the answer away, so the
     * first sale anybody recorded had nowhere to subtract a fee from and
     * every profit figure read high. Etsy's real cut is not the 6.5%
     * everyone quotes -- 6.5% transaction plus 3% + $0.25 processing plus
     * $0.20 to list -- so the number here is checked, not rounded.
     */
    const user = userEvent.setup()
    await renderWizard('full')
    await screen.findByRole('heading', { level: 2 })

    // Through the rest of part one and the landing that ends it, which is
    // the route anybody actually takes to these questions.
    for (let i = 0; i < 10; i += 1) {
      if (screen.queryByRole('button', { name: /keep setting up/i })) break
      await goOn(user)
      await waitFor(() => expect(document.body.textContent).toBeTruthy())
    }
    await user.click(screen.getByRole('button', { name: /keep setting up/i }))
    await waitFor(() => expect(asked()).toMatch(/How do you mostly get paid/i))

    await fill(user, { branch: 'selling' })
    await goOn(user)
    await walkTo(user, /Where do you sell/i)

    await user.click(screen.getByRole('button', { name: /^Etsy$/ }))
    await user.click(screen.getByRole('button', { name: /markets and fairs/i }))
    await goOn(user)

    await waitFor(() => expect(saveChannel).toHaveBeenCalledTimes(2))
    const made = saveChannel.mock.calls.map((c) => c[1]) as unknown as {
      name: string; feePct: number; feeFlat: number
    }[]
    const etsy = made.find((c) => c.name === 'Etsy')
    expect(etsy?.feePct).toBe(9.5)
    expect(etsy?.feeFlat).toBe(0.45)

    // A market stall charges for the table, not a slice of each sale, so
    // Guma does not invent one. The Shelf says out loud that this channel
    // takes nothing rather than leaving it to be discovered.
    const market = made.find((c) => c.name === 'Markets and fairs')
    expect(market?.feePct).toBe(0)
    expect(market?.feeFlat).toBe(0)
  })
})
