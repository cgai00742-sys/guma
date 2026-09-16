// @vitest-environment jsdom
/**
 * The machines tab, rendered — written for one bug in particular.
 *
 * "The save feature of adding clients or printers is not smooth." It was
 * not a smoothness problem. MachinesPane seeded its list from
 * ctx.printerRows with useState and then never looked at ctx again, so the
 * machine you had just saved was in the database and not on the screen. The
 * only way to see it was to leave the tab and come back, which from the
 * outside is indistinguishable from the save having failed.
 *
 * No test caught it because every test asked the data layer what it had
 * stored, and the data layer was right the whole time. This one asks the
 * screen what a person can see, which is the only question that was ever
 * wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { makeCtx, PRINTER_ROW } from '../lib/fixtures'
import type { PrinterRow, ShopContext } from '../lib/data.types'

const machine = (over: Partial<PrinterRow> = {}): PrinterRow => ({
  ...PRINTER_ROW,
  ...over,
})

const savePrinter = vi.fn(async (_s: string, _n: any) => machine())
const setPrinterRetired = vi.fn(async (_s: string, _id: string, _r: boolean) => {})
const deletePrinter = vi.fn(async (_s: string, _id: string) => {})
const listMaterials = vi.fn(async (): Promise<any[]> => [])

vi.mock('../lib/data', async () => {
  const types = await import('../lib/data.types')
  return {
    ...types,
    savePrinter,
    setPrinterRetired,
    deletePrinter,
    listMaterials,
    saveRateCard: vi.fn(),
    saveShopIdentity: vi.fn(),
    saveShopCosts: vi.fn(),
    saveShopQuoteTerms: vi.fn(),
    saveMaterial: vi.fn(),
    recordMaterialPurchase: vi.fn(),
    listMaterialPurchases: vi.fn(async () => []),
    deleteMaterialPurchase: vi.fn(),
  }
})

/**
 * Renders Settings on the machines tab, with a host that reloads the shop
 * context exactly the way App does — which is the half of the bug a test
 * rendering Settings once could never have seen.
 */
async function renderMachines(rows: PrinterRow[]) {
  const { default: Settings } = await import('./Settings')
  const { useState } = await import('react')
  let stored = rows

  function Host() {
    const [ctx, setCtx] = useState<ShopContext>(() => ({ ...makeCtx(), printerRows: stored }))
    return <Settings ctx={ctx} onSaved={() => setCtx({ ...makeCtx(), printerRows: stored })} />
  }

  render(
    <MemoryRouter initialEntries={['/settings?tab=machines']}>
      <Host />
    </MemoryRouter>,
  )
  await screen.findByRole('button', { name: /add a machine/i })
  return {
    /** What the database now holds, for the host to hand back on reload. */
    set: (next: PrinterRow[]) => {
      stored = next
    },
  }
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('adding a machine', () => {
  it('shows the machine on the list without having to leave the tab', async () => {
    const db = await renderMachines([machine({ id: 'p1', name: 'Bay 1' })])
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /\+ add a machine/i }))
    await user.type(screen.getByPlaceholderText('Bay 2'), 'Bay 2')
    savePrinter.mockImplementationOnce(async () => {
      db.set([machine({ id: 'p1', name: 'Bay 1' }), machine({ id: 'p2', name: 'Bay 2' })])
      return machine({ id: 'p2', name: 'Bay 2' })
    })
    await user.click(screen.getByRole('button', { name: /add machine/i }))

    await waitFor(() => expect(savePrinter).toHaveBeenCalledTimes(1))
    // The assertion the old code failed. Not the flash -- the row. The
    // add form has closed by now, so the only "Bay 2" field on screen is
    // the machine itself, sitting in the list next to Bay 1.
    await waitFor(() => expect(screen.getByDisplayValue('Bay 2')).toBeDefined())
    expect(screen.getByDisplayValue('Bay 1')).toBeDefined()
  })

  it('says out loud that it saved, and names what it saved', async () => {
    const db = await renderMachines([])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /\+ add a machine/i }))
    await user.type(screen.getByPlaceholderText('Bay 2'), 'Bay 7')
    savePrinter.mockImplementationOnce(async () => {
      db.set([machine({ id: 'p7', name: 'Bay 7' })])
      return machine({ id: 'p7', name: 'Bay 7' })
    })
    await user.click(screen.getByRole('button', { name: /add machine/i }))
    expect(await screen.findByText(/Bay 7 added/i)).toBeDefined()
  })

  it('shows the failure instead of a tick when the save is refused', async () => {
    await renderMachines([])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /\+ add a machine/i }))
    await user.type(screen.getByPlaceholderText('Bay 2'), 'Bay 9')
    savePrinter.mockRejectedValueOnce(new Error('disk is read-only'))
    await user.click(screen.getByRole('button', { name: /add machine/i }))
    expect(await screen.findByText(/disk is read-only/i)).toBeDefined()
    expect(screen.queryByText(/Bay 9 added/i)).toBeNull()
  })
})

describe('getting rid of a machine', () => {
  it('offers retiring and deleting, and says which is which, before either happens', async () => {
    await renderMachines([machine({ id: 'p1', name: 'Bay 1' })])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /remove/i }))
    expect(screen.getByText(/retiring keeps every project Bay 1 built/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /^retire$/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeDefined()
    // Nothing has been called yet — arming is not doing.
    expect(setPrinterRetired).not.toHaveBeenCalled()
    expect(deletePrinter).not.toHaveBeenCalled()
  })

  it('retires on the second press, and says what retiring did and did not take', async () => {
    const db = await renderMachines([machine({ id: 'p1', name: 'Bay 1' })])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /remove/i }))
    setPrinterRetired.mockImplementationOnce(async () => {
      db.set([machine({ id: 'p1', name: 'Bay 1', archived: 1 })])
    })
    await user.click(screen.getByRole('button', { name: /^retire$/i }))
    await waitFor(() => expect(setPrinterRetired).toHaveBeenCalledWith('shop-1', 'p1', true))
    expect(await screen.findByText(/build history is intact/i)).toBeDefined()
  })

  it('shows the refusal, with its suggestion, when a machine cannot be deleted', async () => {
    await renderMachines([machine({ id: 'p1', name: 'Bay 1' })])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /remove/i }))
    deletePrinter.mockRejectedValueOnce(
      new Error('Bay 1 has 12 build runs behind it. Retire it instead.'),
    )
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(await screen.findByText(/12 build runs behind it/i)).toBeDefined()
  })

  it('lists retired machines apart, with a way back', async () => {
    await renderMachines([
      machine({ id: 'p1', name: 'Bay 1' }),
      machine({ id: 'p2', name: 'Old Ender', archived: 1 }),
    ])
    expect(screen.getByText(/^retired$/i)).toBeDefined()
    expect(screen.getByText('Old Ender')).toBeDefined()
    expect(screen.getByRole('button', { name: /put back in service/i })).toBeDefined()
  })
})

describe('finding a machine', () => {
  it('stays out of the way until there are enough machines to need it', async () => {
    await renderMachines([machine({ id: 'p1', name: 'Bay 1' })])
    expect(screen.queryByRole('searchbox', { name: /find a machine/i })).toBeNull()
  })

  it('narrows the list, and can be undone', async () => {
    await renderMachines([
      machine({ id: 'p1', name: 'Bay 1', model: 'X1C' }),
      machine({ id: 'p2', name: 'Bay 2', model: 'X1C' }),
      machine({ id: 'p3', name: 'Resin corner', model: 'Form 4', tech: 'resin' }),
      machine({ id: 'p4', name: 'Bay 3', model: 'P1S' }),
    ])
    const user = userEvent.setup()
    const box = screen.getByRole('searchbox', { name: /find a machine/i })

    await user.type(box, 'resin')
    expect(screen.getByDisplayValue('Resin corner')).toBeDefined()
    expect(screen.queryByDisplayValue('Bay 1')).toBeNull()
    expect(screen.getByText(/3 machines hidden/i)).toBeDefined()

    await user.click(screen.getByRole('button', { name: /^clear$/i }))
    expect(screen.getByDisplayValue('Bay 1')).toBeDefined()
  })

  it('finds a machine by its technology, which no row displays', async () => {
    await renderMachines([
      machine({ id: 'p1', name: 'Bay 1', model: 'X1C' }),
      machine({ id: 'p2', name: 'Bay 2', model: 'X1C' }),
      machine({ id: 'p3', name: 'Corner unit', model: 'Form 4', tech: 'resin' }),
      machine({ id: 'p4', name: 'Bay 3', model: 'P1S' }),
    ])
    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: /find a machine/i }), 'resin')
    expect(screen.getByDisplayValue('Corner unit')).toBeDefined()
  })
})
