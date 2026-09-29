// @vitest-environment jsdom
/**
 * First run, the whole way, against a real database.
 *
 * Reported by CG: "I just answered all the preliminary questions but then
 * when I clicked finish set up nothing happened." Every existing setup test
 * mocked the data layer -- so none of them could see that the answers did
 * not all come back, and none of them rendered the wizard the way App
 * actually does on first run: IN PLACE of the routes, where calling
 * navigate() changes the URL and nothing on screen moves.
 *
 * So this renders App itself, on node:sqlite with every migration, answers
 * every question through the fields, presses the buttons a person presses,
 * and checks two things at each exit: that the screen actually changed,
 * and that what was typed is in the database when it is read back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const { DatabaseSync } = (await import(/* @vite-ignore */ ['node', 'sqlite'].join(':'))) as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): {
      run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
      all(...p: unknown[]): unknown[]
      get(...p: unknown[]): unknown
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION_SQL = readdirSync(join(here, '../src-tauri/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '../src-tauri/migrations', f), 'utf8'))
  .join('\n')

function freshDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MIGRATION_SQL)
  return {
    sqlite,
    path: 'sqlite:guma.db',
    async execute(sql: string, params: unknown[] = []) {
      const info = sqlite.prepare(sql).run(...params)
      return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) }
    },
    async select(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...params)
    },
  }
}

let currentDb: ReturnType<typeof freshDb>
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => currentDb } }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

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

const asked = () => screen.queryByRole('heading', { level: 2 })?.textContent ?? ''

async function fill(user: ReturnType<typeof userEvent.setup>, values: Record<string, string>) {
  for (const [key, v] of Object.entries(values)) {
    const el = (await waitFor(() => {
      const found = document.getElementById(`w-${key}`)
      if (!found) throw new Error(`no field w-${key} on "${asked()}"`)
      return found
    })) as HTMLInputElement | HTMLSelectElement
    if (el.tagName === 'SELECT') await user.selectOptions(el, v)
    else {
      await user.clear(el)
      await user.type(el, v)
    }
  }
}

async function next(user: ReturnType<typeof userEvent.setup>) {
  const before = asked()
  await user.click(await screen.findByRole('button', { name: /^(next|skip for now)$/i }))
  // Either the question changed or the landing arrived.
  await waitFor(() => expect(asked()).not.toBe(before))
}

async function renderApp() {
  vi.resetModules()
  const { default: App } = await import('./App')
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  )
}

/** Part one, answered the way a person answers it. */
async function answerPartOne(user: ReturnType<typeof userEvent.setup>) {
  // A first run opens on the welcome; its button is the way into setup.
  const start = await screen.findByRole('button', { name: /set up my shop/i })
  await user.click(start)

  await waitFor(() => expect(asked()).toMatch(/what is your shop called/i))
  await fill(user, { name: 'Kahului Fab' })
  await next(user)
  await fill(user, { address: 'Kahului, HI', state: 'HI' })
  await next(user)
  await fill(user, { kwh: '0.4299' })
  await next(user)
  await fill(user, { pName: 'Sakman', pTech: 'fdm' })
  await next(user)
  await fill(user, { pPrice: '1999', pLife: '5000' })
  await next(user)
  await fill(user, { mName: 'PETG', mPerKg: '24' })
  await next(user)
  await fill(user, { designHourly: '65' })
  await next(user)
  await screen.findByText(/that is enough to start/i)
}

beforeEach(() => {
  cleanup()
  currentDb = freshDb()
  localStorage.clear()
  polyfillDialog()
})

describe('first run, every exit goes somewhere and keeps what was typed', () => {
  it('saves every part-one answer', async () => {
    const user = userEvent.setup()
    await renderApp()
    await answerPartOne(user)

    const shop = currentDb.sqlite.prepare('select * from shops').get() as Record<string, unknown>
    expect(shop).toMatchObject({ name: 'Kahului Fab', address: 'Kahului, HI', state: 'HI' })
    expect(Number(shop.electricity_rate_kwh)).toBeCloseTo(0.4299, 4)
    const printer = currentDb.sqlite.prepare('select * from printers').get() as Record<string, unknown>
    expect(printer.name).toBe('Sakman')
    expect(Number(printer.wear_hourly)).toBeCloseTo(0.3998, 3)
    const material = currentDb.sqlite.prepare('select * from materials').get() as Record<string, unknown>
    expect(material.name).toBe('PETG')
    expect(Number(material.cost_per_unit)).toBeCloseTo(0.024, 5)
    const rc = currentDb.sqlite
      .prepare('select design_hourly from rate_cards order by rowid desc')
      .get() as { design_hourly: number }
    expect(Number(rc.design_hourly)).toBe(65)
  })

  it('"Log my first job" leaves the wizard and opens the job', async () => {
    const user = userEvent.setup()
    await renderApp()
    await answerPartOne(user)
    await user.click(screen.getByRole('button', { name: /log my first job/i }))

    // The screen changed -- not just the URL.
    await waitFor(() => expect(screen.queryByText(/that is enough to start/i)).toBeNull())
    expect(await screen.findByText('First job')).toBeDefined()
  })

  it('"Just look around" leaves the wizard for the dashboard', async () => {
    const user = userEvent.setup()
    await renderApp()
    await answerPartOne(user)
    await user.click(screen.getByRole('button', { name: /just look around/i }))
    await waitFor(() => expect(screen.queryByText(/that is enough to start/i)).toBeNull())
    expect(await screen.findByText(/projects open/i)).toBeDefined()
  })

  it('finishes part two, says so, and "Go to my dashboard" actually goes', async () => {
    const user = userEvent.setup()
    await renderApp()
    await answerPartOne(user)
    await user.click(screen.getByRole('button', { name: /keep setting up/i }))

    await waitFor(() => expect(asked()).toMatch(/how do you mostly get paid/i))
    await fill(user, { branch: 'clients' })
    await next(user)
    await fill(user, { pWatts: '340' })
    await next(user)
    await fill(user, { finishingHourly: '45' })
    await next(user)
    await fill(user, { taxLabel: 'GET', taxPct: '4.712' })
    await next(user)
    await fill(user, { email: 'cg@kahuluifab.com', phone: '808-555-0100' })
    await next(user)
    await fill(user, { depositPct: '50' })
    await next(user)
    await fill(user, { minimumOrder: '40' })
    await next(user)
    await fill(user, { markup: '2' })
    await next(user)

    // A different landing from part one's -- the same screen twice is what
    // "nothing happened" looked like.
    await screen.findByText(/setup is finished/i)
    await user.click(screen.getByRole('button', { name: /go to my dashboard/i }))
    await waitFor(() => expect(screen.queryByText(/setup is finished/i)).toBeNull())
    expect(await screen.findByText(/projects open/i)).toBeDefined()

    // And all of it is in the database.
    const shop = currentDb.sqlite.prepare('select * from shops').get() as Record<string, unknown>
    expect(shop).toMatchObject({
      sell_branch: 'clients',
      email: 'cg@kahuluifab.com',
      phone: '808-555-0100',
      tax_label: 'GET',
      // The first answers survived the later saves.
      address: 'Kahului, HI',
      state: 'HI',
    })
    const printer = currentDb.sqlite.prepare('select watts from printers').get() as { watts: number }
    expect(Number(printer.watts)).toBe(340)
    const rc = currentDb.sqlite
      .prepare(
        'select finishing_hourly, deposit_pct, minimum_order, material_markup from rate_cards order by rowid desc',
      )
      .get() as Record<string, number>
    expect(rc).toMatchObject({ finishing_hourly: 45, deposit_pct: 50, minimum_order: 40, material_markup: 2 })

    // Nothing left for the banner to nag about.
    expect(screen.queryByText(/finish setting up|carry on setting up/i)).toBeNull()

    // Coming back to setup does not ask any of it again -- in particular
    // not "How do you mostly get paid?", which used to be thrown away and
    // so was the question every return opened on.
    cleanup()
    vi.resetModules()
    const { default: App } = await import('./App')
    render(
      <MemoryRouter initialEntries={['/setup-guide']}>
        <App />
      </MemoryRouter>,
    )
    await screen.findByText(/setup is finished/i)
    expect(screen.queryByText(/how do you mostly get paid/i)).toBeNull()
  })
})
