// @vitest-environment jsdom
/**
 * The Projects tab's view comes from the URL every time.
 *
 * Found in review (9 Oct 2026): the board's "N drafts →" chip links to
 * /projects?view=list&show=drafts -- the same route -- so the page is not
 * remounted, and a view copied into state at mount left the board on screen
 * under a list URL. The drafts the board hides on purpose were unreachable
 * from the one link that points at them.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

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

beforeEach(() => {
  cleanup()
  // jsdom has no showModal, and the list view opens its field guide the
  // first time; see Jobs.guide.render.test.tsx.
  const proto = window.HTMLDialogElement?.prototype
  if (proto) {
    proto.showModal = function (this: HTMLDialogElement) {
      this.open = true
    }
    proto.close = function (this: HTMLDialogElement) {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  }
})

function Where() {
  const l = useLocation()
  return <div data-testid="where">{l.pathname + l.search}</div>
}

it('the drafts chip on the board opens the list, showing the drafts', async () => {
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
  // One draft: saved, never taken in, so it is not on the board.
  await data.saveQuote({
    shopId,
    ref: await data.nextJobRef(shopId),
    client: { name: 'Hafen GmbH', contact: '', email: '', phone: '', source: '' },
    job: { title: 'Mast brackets', brief: '', neededBy: null, assetOrigin: 'model' },
    quote: {
      design_billing: 'hourly', design_qty: 6, revisions_incl: 2, quantity: 12,
      material_id: ctx.materials[0].id, printer_id: ctx.printers[0].id, units_per_part: 62,
      print_hrs_part: 1.75, finishing_hrs: 2, rush: false, flat_each: 0, discount_pct: 0,
    },
  } as never)

  const { default: Projects } = await import('./Projects')
  render(
    <MemoryRouter initialEntries={['/projects']}>
      <Routes>
        <Route path="/projects" element={<><Projects ctx={ctx} /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )
  const user = userEvent.setup()
  await user.click(await screen.findByRole('link', { name: /1 draft/ }))

  expect(screen.getByTestId('where').textContent).toBe('/projects?view=list&show=drafts')
  expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true')
  expect(await screen.findByText('Mast brackets')).toBeDefined()

  // And the switch still writes the URL both ways.
  await user.click(screen.getByRole('button', { name: 'Board' }))
  expect(screen.getByTestId('where').textContent).toBe('/projects?show=drafts')
  expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe('true')
})
