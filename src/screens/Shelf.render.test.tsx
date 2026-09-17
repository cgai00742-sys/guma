// @vitest-environment jsdom
/**
 * The Shelf, read the way a person reads it.
 *
 * Every number on this screen is one somebody will act on -- whether a
 * market day was worth doing, whether to print more, whether the evening
 * spent designing it has come back. So these assertions are about the
 * figures as they appear, not about the functions behind them: the arithmetic
 * is already proven in selling.test.ts, and what is left to get wrong is
 * showing the right number in the wrong place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { makeCtx } from '../lib/fixtures'
import { makeMoney } from '../lib/pricing'
import type { ChannelRow, ProductRow, SaleRow } from '../lib/data.types'

let products: ProductRow[] = []
let channels: ChannelRow[] = []
let sales: SaleRow[] = []

const listShelf = vi.fn(async () => products)
const listChannels = vi.fn(async () => channels)
const listSales = vi.fn(async () => sales)
const recordSale = vi.fn(async () => 'sale-1')
const deleteSale = vi.fn(async () => {})
const saveProduct = vi.fn(async () => 'prod-new')
const saveBatch = vi.fn(async () => 'batch-new')
const saveChannel = vi.fn(async () => channels[0])

vi.mock('../lib/data', async () => {
  const types = await import('../lib/data.types')
  return {
    ...types,
    listShelf, listChannels, listSales, recordSale, deleteSale,
    saveProduct, saveBatch, saveChannel,
  }
})

/** The fixture shop invoices in euros, which is the point: every figure
 *  below is checked in the shop's OWN currency rather than against a
 *  dollar sign somebody hardcoded. */
const { money } = makeMoney(makeCtx().shop.currency, makeCtx().shop.locale)

/**
 * Intl puts a non-breaking space between the figure and the symbol, and
 * testing-library's default normalizer does not collapse one. Comparing the
 * two without agreeing on that is a test that fails on a space.
 */
const flat = (t: string) => t.replace(/\u00a0/g, ' ').trim()
const NB = { normalizer: flat }
const m = (n: number) => flat(money(n))

const ETSY: ChannelRow = { id: 'ch-etsy', name: 'Etsy', fee_pct: 9.5, fee_flat: 0.45, archived: 0 }

/** Forty made at $1.15, twelve sold at $9 through Etsy. */
function keychains(): ProductRow[] {
  return [
    {
      id: 'prod-1',
      name: 'Hex keychain',
      design_job_id: 'job-1',
      design_cost: 150,
      design_hours: 6,
      archived: 0,
      batches: [
        {
          id: 'batch-1',
          product_id: 'prod-1',
          job_id: 'job-1',
          units_made: 40,
          unit_cost: 1.15,
          made_on: '2026-09-01',
          note: null,
          units_sold: 12,
          units_left: 28,
          revenue: 108,
          fees: 10.71,
          cost_of_sold: 13.8,
          estimated: false,
        },
      ],
    },
  ]
}

async function renderShelf() {
  vi.resetModules()
  const { default: Shelf } = await import('./Shelf')
  render(
    <MemoryRouter>
      <Shelf ctx={makeCtx()} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  products = []
  channels = []
  sales = []
})

describe('an empty shelf', () => {
  it('says what this half of the business is for, rather than showing a blank table', async () => {
    await renderShelf()
    expect(await screen.findByText(/Nothing on the shelf yet/i)).toBeDefined()
    expect(document.body.textContent).toMatch(/after the stall's cut/i)
    expect(document.body.textContent).toMatch(/unsold stock/i)
  })
})

describe('what a product has actually done', () => {
  beforeEach(() => {
    products = keychains()
    channels = [ETSY]
    sales = [
      {
        id: 'sale-1',
        batch_id: 'batch-1',
        channel_id: 'ch-etsy',
        channel_name: 'Etsy',
        units: 12,
        unit_price: 9,
        fee_total: 10.71,
        sold_on: '2026-09-14',
        note: null,
      },
    ]
  })

  it('reports what was kept after the platform took its cut, not the takings', async () => {
    await renderShelf()
    const row = (await screen.findByText('Hex keychain')).closest('tr') as HTMLTableRowElement

    // $108 came in. Etsy took $10.71. Twelve units cost $13.80 to make.
    // The number that matters is the third one, and a shop that reads the
    // first one thinks the day went 30% better than it did.
    expect(within(row).getByText(m(108), NB)).toBeDefined()
    expect(within(row).getByText(`−${m(10.71)}`, NB)).toBeDefined()
    expect(within(row).getByText(m(83.49), NB)).toBeDefined()
  })

  it('counts the cost of what SOLD, and shows the rest as stock', async () => {
    await renderShelf()
    const row = (await screen.findByText('Hex keychain')).closest('tr') as HTMLTableRowElement
    // Twenty-eight left at $1.15 is $32.20 of money already spent that has
    // not come back. Not a loss -- a shelf.
    expect(within(row).getByText(m(32.2), NB)).toBeDefined()
  })

  it('says how far the design has paid itself back, in money rather than a bar', async () => {
    await renderShelf()
    const row = (await screen.findByText('Hex keychain')).closest('tr') as HTMLTableRowElement
    expect(within(row).getByText(`${m(83.49)} of ${m(150)}`, NB)).toBeDefined()
  })
})

describe('recording a sale', () => {
  beforeEach(() => {
    products = keychains()
    channels = [ETSY]
  })

  it('shows the cut before it is recorded, not after', async () => {
    const user = userEvent.setup()
    await renderShelf()
    await user.click(await screen.findByText('Hex keychain'))
    await user.click(await screen.findByRole('button', { name: /record a sale/i }))

    await user.clear(screen.getByLabelText(/how many/i))
    await user.type(screen.getByLabelText(/how many/i), '10')
    await user.type(screen.getByLabelText(/price each/i), '10')
    await user.selectOptions(screen.getByLabelText(/where/i), 'ch-etsy')

    // $100 in, $9.95 to Etsy, $90.05 kept -- said out loud before somebody
    // commits to the price, which is the only moment it can change anything.
    await waitFor(() => expect(screen.getByText(m(100), NB)).toBeDefined())
    expect(screen.getByText(`−${m(9.95)}`, NB)).toBeDefined()
    expect(screen.getByText(m(90.05), NB)).toBeDefined()
  })

  it('sends the sale against the batch, at the price and channel chosen', async () => {
    const user = userEvent.setup()
    await renderShelf()
    await user.click(await screen.findByText('Hex keychain'))
    await user.click(await screen.findByRole('button', { name: /record a sale/i }))

    await user.clear(screen.getByLabelText(/how many/i))
    await user.type(screen.getByLabelText(/how many/i), '10')
    await user.type(screen.getByLabelText(/price each/i), '10')
    await user.selectOptions(screen.getByLabelText(/where/i), 'ch-etsy')
    await user.click(screen.getByRole('button', { name: /record it/i }))

    await waitFor(() => expect(recordSale).toHaveBeenCalled())
    const [, input] = recordSale.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(input.batchId).toBe('batch-1')
    expect(input.channelId).toBe('ch-etsy')
    expect(input.units).toBe(10)
    expect(input.unitPrice).toBe(10)
    // The fee is NOT sent: it is worked out and frozen by the backend from
    // the channel, so a screen can never disagree with what was stored.
    expect(Object.keys(input)).not.toContain('feeTotal')
  })

  it('will not offer to sell more than are on the shelf', async () => {
    const user = userEvent.setup()
    products[0].batches[0].units_left = 0
    await renderShelf()
    await user.click(await screen.findByText('Hex keychain'))
    const btn = (await screen.findByRole('button', { name: /all sold/i })) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})

describe('a channel that takes nothing', () => {
  it('says so, because silence there reads as profit that is not real', async () => {
    products = keychains()
    channels = [{ id: 'ch-site', name: 'My own site', fee_pct: 0, fee_flat: 0, archived: 0 }]
    await renderShelf()
    expect(await screen.findByText('My own site')).toBeDefined()
    expect(document.body.textContent).toMatch(/reading high until you say so/i)
  })
})

describe('stock that predates Guma', () => {
  it('is counted, and labelled as the estimate it is', async () => {
    products = keychains()
    products[0].batches[0].job_id = null
    products[0].batches[0].estimated = true
    const user = userEvent.setup()
    await renderShelf()
    await user.click(await screen.findByText('Hex keychain'))
    expect(await screen.findByText(/cost estimated/i)).toBeDefined()
  })
})
