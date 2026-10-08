// @vitest-environment jsdom
/**
 * Revising a quote, against a real database: the price on screen is the
 * price that is stored, and the screen asks for what the save will demand.
 *
 * Each case is a bug found in review (9 Oct 2026):
 *   - the ceiling box vanished once a later version existed, while the save
 *     still compared against the accepted one and refused without a reason;
 *   - a quote whose machine had been retired re-priced its machine time and
 *     wear at zero, under a dropdown showing a different machine;
 *   - with build lines, the screen priced input.quantity while the save
 *     stored the lines' copies, so a per-piece price disagreed with the PDF;
 *   - the total was stored with toFixed(2) and shown with round2, a cent
 *     apart on a half-cent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const { DatabaseSync } = (await import(/* @vite-ignore */ ['node', 'sqlite'].join(':'))) as {
  DatabaseSync: new (path: string) => any
}
const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '../../src-tauri/migrations')
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n')

function freshDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MIGRATION_SQL)
  return {
    path: 'sqlite:guma.db',
    sqlite,
    async execute(sql: string, params: unknown[] = []) {
      const info = sqlite.prepare(sql).run(...(params as never[]))
      return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) }
    },
    async select(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...(params as never[]))
    },
  }
}

let currentDb: ReturnType<typeof freshDb>
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => currentDb } }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

const SHOP = {
  name: 'Werkstatt Drei', currency: 'EUR', locale: 'de-DE', paper: 'a4', tax_label: 'MwSt.',
  tax_pct: 19, state: '', quote_valid_days: 30, lead_days: 10, electricity_rate_kwh: 0.32,
}
const RATES = {
  design_hourly: 85, finishing_hourly: 55, rush_pct: 35, minimum_order: 85, deposit_pct: 50,
  deposit_when: 'design', deposit_waive_below: 150, material_markup: 2, revisions_incl: 2,
  revision_hourly: 85,
}

type Q = Record<string, unknown>
async function seed(
  opts: { quote?: Q; builds?: (printerId: string) => unknown[]; assetOrigin?: string } = {},
) {
  currentDb = freshDb()
  vi.resetModules()
  const data = await import('../lib/data')
  const shopId = await data.setupShop({
    shop: SHOP,
    rates: RATES,
    printer: { name: 'Prusa XL', model: 'XL 5T', tech: 'fdm', rate_hourly: 9, wear_hourly: 3, watts: 350 },
    materials: [{ name: 'PLA', kind: 'PLA', swatch: '#5A6B7C', unit: 'g', cost_per_unit: 0.095 }],
    fullName: 'Anke Roth',
  } as never)
  const ctx = await data.loadShopContext()
  const saved = await data.saveQuote({
    shopId,
    ref: await data.nextJobRef(shopId),
    client: { name: 'Hafen GmbH', contact: '', email: '', phone: '', source: '' },
    job: { title: 'Mast brackets', brief: '', neededBy: null, assetOrigin: opts.assetOrigin ?? 'model' },
    quote: {
      design_billing: 'hourly', design_qty: 6, revisions_incl: 2, quantity: 12,
      material_id: ctx.materials[0].id, printer_id: ctx.printers[0].id, units_per_part: 62,
      print_hrs_part: 1.75, finishing_hrs: 2, rush: false, flat_each: 0, discount_pct: 0,
      ...opts.quote,
    },
    builds: (opts.builds?.(ctx.printers[0].id) ?? []) as never,
  } as never)
  await data.takeProjectIn(shopId, saved.jobId, ctx.profile.id)
  return { ctx, data, jobId: saved.jobId }
}

async function revise(ctx: unknown, jobId: string) {
  const { default: Intake } = await import('./Intake')
  render(
    <MemoryRouter initialEntries={[`/intake?revise=${jobId}`]}>
      <Routes>
        <Route path="/intake" element={<Intake ctx={ctx as never} />} />
        <Route path="/quote/:quoteId/print" element={<div>PRINTABLE</div>} />
      </Routes>
    </MemoryRouter>,
  )
  await waitFor(() =>
    expect((screen.getByLabelText(/project title/i) as HTMLInputElement).value).toBe('Mast brackets'),
  )
}

/** The big total at the top of the quote card, as the shop reads it. */
function shownTotal() {
  const label = [...document.querySelectorAll('span')].find((s) => s.textContent === 'Total due')!
  // Intl puts a no-break space before the euro sign.
  return label.nextElementSibling!.textContent!.replace(/\s/g, ' ')
}

const newest = () =>
  currentDb.sqlite.prepare('select total, deposit_due, quantity from quotes order by version desc limit 1').get() as {
    total: number
    deposit_due: number
    quantity: number
  }

beforeEach(cleanup)

describe('the revision ceiling', () => {
  it('still asks what the client changed once a later version exists', async () => {
    const { ctx, data, jobId } = await seed()
    // v1 accepted at 100, so today's price is far above the ceiling.
    currentDb.sqlite.prepare("update quotes set status = 'accepted', total = 100 where job_id = ?").run(jobId)
    // v2: a draft revision. The newest version is no longer the accepted one.
    const d = await data.loadProjectDetail(ctx.shop.id, jobId)
    await data.saveQuote({
      shopId: ctx.shop.id, ref: d.ref, reviseJobId: jobId,
      client: { name: 'Hafen GmbH', contact: '', email: '', phone: '', source: '' },
      job: { title: 'Mast brackets', brief: '', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'hourly', design_qty: 6, revisions_incl: 2, quantity: 12,
        material_id: ctx.materials[0].id, printer_id: ctx.printers[0].id, units_per_part: 62,
        print_hrs_part: 1.75, finishing_hrs: 2, rush: false, flat_each: 0, discount_pct: 0,
      },
    } as never)

    await revise(ctx, jobId)
    expect(screen.getByText(/above the price they accepted/i)).toBeDefined()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/in your words/i), 'Twice the brackets, new mount')
    await user.click(screen.getByRole('button', { name: /^save revision as pdf$/i }))
    await screen.findByText('PRINTABLE')
    const v3 = currentDb.sqlite
      .prepare('select version, status, change_reason from quotes order by version desc limit 1')
      .get()
    expect(v3).toEqual({ version: 3, status: 'sent', change_reason: 'Twice the brackets, new mount' })
  })
})

describe('a quote whose machine has been retired', () => {
  it('prices the same, and shows that machine as the one picked', async () => {
    const { ctx, data, jobId } = await seed()
    await revise(ctx, jobId)
    const before = shownTotal()
    cleanup()

    await data.savePrinter(ctx.shop.id, {
      name: 'Bambu X1', model: 'X1C', tech: 'fdm', rate_hourly: 9, wear_hourly: 3, watts: 350,
    } as never)
    await data.setPrinterRetired(ctx.shop.id, ctx.printers[0].id, true)
    const after = await data.loadShopContext()
    await revise(after, jobId)

    expect(shownTotal()).toBe(before)
    const select = screen.getByLabelText(/^machine$/i) as HTMLSelectElement
    expect(select.value).toBe(ctx.printers[0].id)
    expect(select.selectedOptions[0].textContent).toMatch(/Prusa XL.*\(retired\)/)
  })

  it('is never offered on a new quote', async () => {
    const { ctx, data } = await seed()
    await data.savePrinter(ctx.shop.id, {
      name: 'Bambu X1', model: 'X1C', tech: 'fdm', rate_hourly: 9, wear_hourly: 3, watts: 350,
    } as never)
    await data.setPrinterRetired(ctx.shop.id, ctx.printers[0].id, true)
    const after = await data.loadShopContext()
    const { default: Intake } = await import('./Intake')
    render(
      <MemoryRouter initialEntries={['/intake']}>
        <Intake ctx={after} />
      </MemoryRouter>,
    )
    await userEvent.setup().click(await screen.findByRole('button', { name: /someone is paying/i }))
    const options = [...(screen.getByLabelText(/^machine$/i) as HTMLSelectElement).options].map((o) => o.textContent)
    expect(options.some((o) => /retired|Prusa XL/.test(o ?? ''))).toBe(false)
  })
})

describe('the price on screen is the price stored', () => {
  it('prices build lines at their own copies: flat per piece, 4 + 2 copies', async () => {
    const { ctx, jobId } = await seed({
      assetOrigin: 'ready',
      quote: { design_billing: 'none', design_qty: 0, quantity: 5, flat_each: 30, units_per_part: 0, print_hrs_part: 0, finishing_hrs: 0 },
      builds: (printerId) => [
        { label: 'Bracket', printerId, materialId: null, qty: 3, unitsPerPart: 20, printHrsPerPart: 1 },
        { label: 'Cap', printerId, materialId: null, qty: 2, unitsPerPart: 10, printHrsPerPart: 0.5 },
      ],
    })
    await revise(ctx, jobId)
    // 3 + 2 becomes 4 + 2: six pieces at 30, plus 19% -> 214,20 €.
    fireEvent.change(screen.getByLabelText('Copies of Bracket'), { target: { value: '4' } })
    await waitFor(() => expect(shownTotal()).toBe('214,20 €'))

    await userEvent.setup().click(screen.getByRole('button', { name: /^save revision as pdf$/i }))
    await screen.findByText('PRINTABLE')
    expect(newest()).toEqual({ total: 214.2, deposit_due: 107.1, quantity: 6 })
  })

  it('stores the total to the same cent the screen shows', async () => {
    // 88,50 € + 19% = 105.315: shown as 105,32 €, and toFixed(2) stored 105.31.
    const { ctx, jobId } = await seed({
      assetOrigin: 'ready',
      quote: { design_billing: 'none', design_qty: 0, quantity: 1, flat_each: 88.5, finishing_hrs: 0 },
    })
    await revise(ctx, jobId)
    expect(shownTotal()).toBe('105,32 €')
    await userEvent.setup().click(screen.getByRole('button', { name: /^save revision as pdf$/i }))
    await screen.findByText('PRINTABLE')
    expect(newest().total).toBe(105.32)
  })
})

