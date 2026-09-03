// @vitest-environment jsdom
/**
 * The project page, rendered against a real database.
 *
 * Nothing is mocked below the screen: @tauri-apps/plugin-sql is swapped for
 * node:sqlite, every migration is applied, and the project is created by the
 * same setupShop / saveQuote / takeProjectIn the app calls. So this exercises
 * the migrations, data.local.ts, the dispatcher, gates.ts, pricing.ts and the
 * screen in one pass.
 *
 * It exists because of one report: "I tried to move a new project forward but
 * no success." Three separate dead ends were behind it, and all three were
 * invisible to a test that never rendered a page:
 *   - the intake gate read a brief no screen could edit
 *   - the approval gate read a quote status nothing could change
 *   - saving stranded the user on the form
 * The assertions here are those three, made permanent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Loaded through a specifier Vite cannot see: under the jsdom environment
// it treats a literal 'node:sqlite' import as browser code and refuses to
// bundle it. The engine underneath is the same one the desktop app uses.
const { DatabaseSync } = (await import(/* @vite-ignore */ ['node', 'sqlite'].join(':'))) as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): {
      run(...p: never[]): { changes: number | bigint; lastInsertRowid: number | bigint }
      all(...p: never[]): unknown[]
    }
  }
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

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => currentDb },
}))
// The dispatcher picks its backend from this. Saying yes routes every call
// through data.local.ts, which is the code the desktop app runs.
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

/** A shop in Berlin, so any dollar sign that appears is a failure. */
const SHOP = {
  name: 'Werkstatt Drei',
  currency: 'EUR',
  locale: 'de-DE',
  paper: 'a4',
  tax_label: 'MwSt.',
  tax_pct: 19,
  state: '',
  quote_valid_days: 30,
  lead_days: 10,
  electricity_rate_kwh: 0.32,
}
const RATES = {
  design_hourly: 85,
  finishing_hourly: 55,
  rush_pct: 35,
  minimum_order: 85,
  deposit_pct: 50,
  deposit_when: 'design',
  deposit_waive_below: 150,
  material_markup: 2,
  revisions_incl: 2,
  revision_hourly: 85,
}

/** Seeds a shop and one project, and returns what the screen needs. */
async function seed({ takeIn }: { takeIn: boolean }) {
  currentDb = freshDb()
  vi.resetModules()
  const data = await import('../lib/data')

  const shopId = await data.setupShop({
    shop: SHOP,
    rates: RATES,
    printer: { name: 'Prusa XL', model: 'XL 5T', tech: 'fdm', rate_hourly: 9, wear_hourly: 3, watts: 350 },
    materials: [{ name: 'PLA', kind: 'PLA', swatch: '#5A6B7C', unit: 'g', cost_per_unit: 0.095 }],
    fullName: 'Anke Roth',
  })
  const ctx = await data.loadShopContext()
  const ref = await data.nextJobRef(shopId)
  const saved = await data.saveQuote({
    shopId,
    ref,
    client: { name: 'Hafen GmbH', contact: '', email: '', phone: '', source: '' },
    job: { title: 'Mast brackets', brief: '', neededBy: null, assetOrigin: 'model' },
    quote: {
      design_billing: 'hourly',
      design_qty: 6,
      revisions_incl: 2,
      quantity: 12,
      material_id: ctx.materials[0].id,
      printer_id: ctx.printers[0].id,
      units_per_part: 62,
      print_hrs_part: 1.75,
      finishing_hrs: 2,
      rush: false,
      flat_each: 0,
      discount_pct: 0,
    },
  })
  if (takeIn) await data.takeProjectIn(shopId, saved.jobId, ctx.profile.id)
  return { ctx, jobId: saved.jobId, ref, data }
}

async function renderProject(jobId: string, ctx: any) {
  const { default: Project } = await import('./Project')
  render(
    <MemoryRouter initialEntries={[`/project/${jobId}`]}>
      <Routes>
        <Route path="/project/:jobId" element={<Project ctx={ctx} />} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByText('Mast brackets')
}

beforeEach(cleanup)

describe('a draft that has not been taken in', () => {
  it('says it is a draft and offers to take it in', async () => {
    const { ctx, jobId } = await seed({ takeIn: false })
    await renderProject(jobId, ctx)

    expect(screen.getByText(/saved as a draft/i)).toBeDefined()
    expect(screen.getByText(/not on the pipeline board/i)).toBeDefined()
    // Two of them, top and footer, so it is reachable without scrolling
    // whichever end of a long project page you are at.
    const takeIn = screen.getAllByRole('button', { name: /take it into intake/i })
    expect(takeIn.length).toBeGreaterThan(0)
    expect(takeIn.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true)
  })

  it('takes it in for real, and the button becomes an advance', async () => {
    const { ctx, jobId } = await seed({ takeIn: false })
    await renderProject(jobId, ctx)
    const user = userEvent.setup()

    await user.click(screen.getAllByRole('button', { name: /take it into intake/i })[0])
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: /take it into intake/i })).toHaveLength(0),
    )
    expect(screen.getAllByRole('button', { name: /advance to|^delivered$/i }).length).toBeGreaterThan(0)
  })
})

describe('every gate a project can be stuck behind has a control that clears it', () => {
  it('gives the brief an editor, because the intake gate reads it', async () => {
    // The exact dead end from the report: brief was auto-gated and no screen
    // could set it, so intake could never be cleared.
    const { ctx, jobId } = await seed({ takeIn: true })
    await renderProject(jobId, ctx)

    const brief = screen.getByLabelText(/what they asked for/i) as HTMLTextAreaElement
    expect(screen.getByText(/nothing written down/i)).toBeDefined()

    const user = userEvent.setup()
    await user.click(brief)
    await user.paste('Twelve stainless-look mast brackets, 6 mm bolt holes, matte finish.')
    await user.tab() // the editor saves on blur

    await waitFor(() => expect(screen.getByText(/^written down$/i)).toBeDefined())
  })

  it('prints the fix hint for every automatic item that is not yet satisfied', async () => {
    // gates.ts requires a `fix` on every automatic item. This is the check
    // that the fix reaches the screen, rather than existing only in a type.
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await renderProject(jobId, ctx)

    const { GATES } = await import('../lib/gates')
    const detail = await data.loadProjectDetail(ctx.shop.id, jobId)
    const unmet = GATES.intake.filter(
      (i) => i.auto && i.auto(detail.facts) === false && i.fix,
    )
    expect(unmet.length).toBeGreaterThan(0)

    const page = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    for (const item of unmet) {
      expect(page).toContain(item.fix!.replace(/\s+/g, ' '))
    }
  })

  it('lets the quote status be changed, because the approval gate reads it', async () => {
    const { ctx, jobId } = await seed({ takeIn: true })
    await renderProject(jobId, ctx)

    const select = screen.getByLabelText(/^Quote is/) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toContain('accepted')

    const user = userEvent.setup()
    await user.selectOptions(select, 'sent')
    await waitFor(() => expect(screen.getByText(/quote sent/i)).toBeDefined())
  })
})

describe('the money on the project page', () => {
  it('is the shop’s currency everywhere, with no dollar sign anywhere', async () => {
    const { ctx, jobId } = await seed({ takeIn: true })
    await renderProject(jobId, ctx)
    const body = document.body.textContent ?? ''
    expect(body).toContain('€')
    expect(body).not.toContain('$')
  })

  it('formats amounts the German way, decimal comma and all', async () => {
    const { ctx, jobId } = await seed({ takeIn: true })
    await renderProject(jobId, ctx)
    // 1.013,30 € before tax on the quoted-vs-actual table. The bug this
    // guards is that same figure rendering as 1,013.30 next to a euro sign.
    expect(document.body.textContent).toMatch(/1\.\d{3},\d{2}/)
  })
})

describe('a project can always be got rid of', () => {
  it('arms in two steps, and names what goes with it', async () => {
    const { ctx, jobId, ref } = await seed({ takeIn: true })
    await renderProject(jobId, ctx)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /^delete$/i }))

    // Step two states the reference and the collateral rather than asking a
    // bare "are you sure?".
    expect(await screen.findByText(new RegExp(`Delete ${ref} for good`, 'i'))).toBeDefined()
    expect(screen.getByText(/its quote/i)).toBeDefined()
    expect(screen.getByText(/cannot be undone/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /keep it/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /delete it/i })).toBeDefined()
  })

  it('backs out without deleting anything', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await renderProject(jobId, ctx)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /^delete$/i }))
    await user.click(screen.getByRole('button', { name: /keep it/i }))

    expect(screen.getByRole('button', { name: /^delete$/i })).toBeDefined()
    await expect(data.loadProjectDetail(ctx.shop.id, jobId)).resolves.toBeTruthy()
  })
})
