// @vitest-environment jsdom
/**
 * The dashboard, against real numbers.
 *
 * The risk with a page like this is not that it crashes -- it is that it
 * quietly says something false. A shop that has logged nothing has not
 * spent zero and has not achieved a 0% failure rate; it has not measured
 * either. Those two assertions are the reason this file exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { makeCtx } from '../lib/fixtures'
import type { JobListRow, MaterialRow, ProductRow } from '../lib/data.types'

let jobs: JobListRow[] = []
let materials: MaterialRow[] = []
let shelf: ProductRow[] = []

vi.mock('../lib/data', async () => {
  const types = await import('../lib/data.types')
  return {
    ...types,
    listJobs: vi.fn(async () => jobs),
    listMaterials: vi.fn(async () => materials),
    listShelf: vi.fn(async () => shelf),
  }
})

const job = (over: Record<string, unknown> = {}, facts: Record<string, unknown> = {}): JobListRow =>
  ({
    jobId: 'j1', ref: 'G-1', title: 'Reef markers', clientId: 'c1', clientName: 'Reef Watch',
    clientKind: 'business', createdAt: '2026-01-01', phase: 'building', priority: 'medium',
    quoteId: 'q1', quoteStatus: 'accepted', total: 400, gateAnswers: {},
    facts: {
      kind: 'client', phase: 'building', priority: 'medium', createdAt: '2026-01-01',
      takenInAt: '2026-01-01', neededBy: null, windowFrom: null, windowLocked: false,
      atRisk: false, deliveryOn: null, deliveryHow: null, brief: null, poc: null,
      quoteStatus: 'accepted', quoteTotal: 400, depositDue: 0, depositOwed: 0, balanceOwed: 0,
      lastActivityAt: null, minimumOrder: 0, actualCost: 0, hasActuals: false, actualRuns: 0,
      actualHours: 0, machineHours: 0, materialUnits: 0, failedUnits: 0, parts: 0,
      copies: 0, copiesDone: 0, partsPrinted: 0, partsPassed: 0, partsReprint: 0, reprintsEver: 0,
      ...facts,
    },
    ...over,
  }) as unknown as JobListRow

const material = (over: Partial<MaterialRow> = {}): MaterialRow =>
  ({
    id: 'm1', name: 'PETG black', kind: 'filament', swatch: '#000', unit: 'g',
    costPerUnit: 0.025, sellOverride: null, onHand: 900, reorderAt: 200, archived: false,
    avgCostPerUnit: 0.025, costBasis: 'estimate', purchases: 0, purchasedQty: 0,
    purchasedSpend: 0, lastPurchasedOn: null, lastCostPerUnit: null,
    ...over,
  }) as unknown as MaterialRow

async function renderDash() {
  const { default: Dashboard } = await import('./Dashboard')
  render(
    <MemoryRouter>
      <Dashboard ctx={makeCtx()} />
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  jobs = []
  materials = []
  shelf = []
})

describe('what it will not claim', () => {
  it('does not report zero cost for a shop that has logged nothing', async () => {
    jobs = [job({ phase: 'delivered' }, { phase: 'delivered', hasActuals: false })]
    await renderDash()
    // A dash and a reason, not "$0.00" -- which would read as "that job was
    // free" rather than "you have not told me yet".
    expect(screen.getByText(/no build runs logged yet/i)).toBeDefined()
  })

  it('does not report a 0% failure rate that was never measured', async () => {
    jobs = [job()]
    await renderDash()
    expect(screen.getByText(/no runs logged yet/i)).toBeDefined()
    expect(screen.queryByText(/0% of material lost/i)).toBeNull()
  })

  it('values shelf stock at what it cost, never at what it might sell for', async () => {
    shelf = [
      {
        id: 'p1', name: 'Buoy', design_job_id: null, design_cost: null, design_hours: null,
        archived: 0,
        batches: [
          { id: 'b1', product_id: 'p1', job_id: null, units_made: 10, unit_cost: 2, made_on: '2026-01-01', note: null, units_sold: 4, units_left: 6, revenue: 200, fees: 0, cost_of_sold: 8 },
        ],
      } as unknown as ProductRow,
    ]
    await renderDash()
    // 6 left x 2 cost = 12. Revenue of 200 must not appear as "value".
    expect(screen.getByText(/6 · 12[.,]00/)).toBeDefined()
    expect(screen.queryByText(/6 · 200[.,]00/)).toBeNull()
  })
})

describe('what it counts', () => {
  it('counts only delivered work in the cost of work delivered', async () => {
    jobs = [
      job({ jobId: 'a', phase: 'delivered' }, { phase: 'delivered', hasActuals: true, actualCost: 120 }),
      // In progress: material has been consumed, but nothing has been sold.
      job({ jobId: 'b' }, { hasActuals: true, actualCost: 999 }),
    ]
    await renderDash()
    // The fixture shop is German, so money renders "120,00 €". Matching a
    // dollar sign here would be asserting the shop's country, which
    // locale.test.ts exists to stop.
    expect(screen.getByText(/120[.,]00/)).toBeDefined()
    expect(screen.queryByText(/1[.,]119/)).toBeNull()
  })

  it('shows a failure rate once there is material to measure it against', async () => {
    jobs = [job({}, { materialUnits: 200, failedUnits: 30, machineHours: 4, actualRuns: 3 })]
    await renderDash()
    expect(screen.getByText(/15% of material lost/i)).toBeDefined()
  })

  it('flags materials at or below their reorder point', async () => {
    materials = [
      material({ id: 'low', name: 'PLA white', onHand: 150, reorderAt: 200 }),
      material({ id: 'ok', name: 'PETG black', onHand: 900, reorderAt: 200 }),
    ]
    await renderDash()
    expect(screen.getByText(/1 at or below reorder/i)).toBeDefined()
    expect(screen.getByText(/150 g left · reorder at 200/i)).toBeDefined()
  })

  it('counts the value of what is actually on the shelf', async () => {
    materials = [material({ onHand: 1000, avgCostPerUnit: 0.03 } as unknown as Partial<MaterialRow>)]
    await renderDash()
    // 1000 units at the weighted average of 0.03. It appears twice on
    // purpose -- once on the tile, once in the Stock panel -- so this
    // scopes to the tile rather than asserting the page has exactly one.
    const tile = screen.getByRole('link', { name: /materials on hand/i })
    expect(tile.textContent).toMatch(/30[.,]00/)
  })
})

describe('every number goes somewhere', () => {
  it('links each tile to the screen that explains it', async () => {
    await renderDash()
    const href = (name: RegExp) =>
      screen.getByRole('link', { name }).getAttribute('href')
    expect(href(/projects open/i)).toBe('/projects')
    expect(href(/printer fleet/i)).toBe('/settings?tab=machines')
    expect(href(/materials on hand/i)).toBe('/settings?tab=materials')
  })

  it('links a flagged project straight to that project', async () => {
    jobs = [job({ jobId: 'late', title: 'Late one' }, { neededBy: '2020-01-01' })]
    await renderDash()
    const link = await screen.findByRole('link', { name: /late one/i })
    expect(link.getAttribute('href')).toBe('/project/late')
  })
})
