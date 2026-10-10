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
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
    sqlite: sqlite as any,
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

async function moveTo(
  data: unknown,
  ctx: { shop: { id: string }; profile: { id: string } },
  jobId: string,
  phase: 'approval' | 'design' | 'scheduled' | 'building' | 'review' | 'delivered',
) {
  const d = data as { updateJobPhase: (a: string, b: string, c: string, p: never) => Promise<void> }
  const ladder = ['approval', 'design', 'scheduled', 'building', 'review', 'delivered'] as const
  for (const to of ladder.slice(0, ladder.indexOf(phase) + 1)) {
    await d.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to as never)
  }
}

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

  it('lets the quote status be changed at Approval, because its gate reads it', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'approval')
    await renderProject(jobId, ctx)

    const select = screen.getByLabelText(/^Quote is/) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toContain('accepted')

    const user = userEvent.setup()
    await user.selectOptions(select, 'sent')
    await waitFor(() => expect(screen.getAllByText(/quote sent/i).length).toBeGreaterThan(0))
  })
})

describe('the money on the project page', () => {
  it('is the shop’s currency everywhere, with no dollar sign anywhere', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'review')
    await renderProject(jobId, ctx)
    const body = document.body.textContent ?? ''
    expect(body).toContain('€')
    expect(body).not.toContain('$')
  })

  it('formats amounts the German way, decimal comma and all', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'review')
    await renderProject(jobId, ctx)
    // 1.013,30 € before tax on the quoted-vs-actual table. The bug this
    // guards is that same figure rendering as 1,013.30 next to a euro sign.
    expect(document.body.textContent).toMatch(/1\.\d{3},\d{2}/)
  })
})

describe('each stage shows only what moves it forward (CG, 7 Oct)', () => {
  it('Intake: the brief and the quote, then the gate -- nothing about printing', async () => {
    const { ctx, jobId } = await seed({ takeIn: true })
    await renderProject(jobId, ctx)
    expect(screen.getByLabelText(/what they asked for/i)).toBeDefined()
    expect(screen.getByLabelText(/point of contact/i)).toBeDefined()
    expect(screen.queryByLabelText(/import a sliced file/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /record a build run/i })).toBeNull()
    expect(document.querySelector('[data-fold="build"]')).toBeNull()
    // The gate is the last section on the page.
    const sections = [...document.querySelectorAll('[data-fold]')].map((e) => e.getAttribute('data-fold'))
    expect(sections[sections.length - 1]).toBe('gate')
    // The record is there, folded, before the work.
    expect(sections.indexOf('sofar')).toBeLessThan(sections.indexOf('brief'))
    expect((document.querySelector('[data-fold="sofar"]') as HTMLDetailsElement).open).toBe(false)
  })

  it('Design: earlier stages are history, read-only, filed by stage', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'design')
    await renderProject(jobId, ctx)
    expect(document.querySelector('[data-fold="build"]')).not.toBeNull()
    // The brief is in the record, inside a disabled fieldset.
    const brief = screen.getByLabelText(/what they asked for/i) as HTMLTextAreaElement
    expect(brief.closest('fieldset')?.disabled).toBe(true)
    expect(brief.closest('details.sofar-stage')?.querySelector('summary')?.textContent).toMatch(/Intake/)
    // No printing before In build.
    expect(screen.queryByRole('button', { name: /record a build run/i })).toBeNull()
  })

  it('a gate item can be skipped with a reason, and the record says so', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'design')
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^skip the client signed off the design$/i }))
    await user.type(screen.getByLabelText(/why skip it/i), 'Signed off on the phone')
    await user.click(screen.getByRole('button', { name: /^skip it$/i }))
    await screen.findByText(/Skipped — Signed off on the phone/)
    await screen.findByText(/Skipped “The client signed off the design”\. Why: Signed off on the phone/)
  })

  it('Delivered: the whole project, open to review', async () => {
    localStorage.clear()
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'delivered')
    await renderProject(jobId, ctx)
    expect((document.querySelector('[data-fold="sofar"]') as HTMLDetailsElement).open).toBe(true)
    const stages = [...document.querySelectorAll('details.sofar-stage > summary h4')].map((e) => e.textContent)
    expect(stages).toEqual(['Intake', 'Client approval', 'Design', 'Scheduled', 'In build', 'Review'])
    expect(document.querySelector('[data-fold="gate"]')).toBeNull()
  })
})

describe('client approval: go ahead without acceptance or deposit (CG, 7 Oct)', () => {
  async function atApproval({ sent }: { sent: boolean }) {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'approval')
    // Sent with a deposit due and nothing paid: both money items open.
    if (sent) currentDb.sqlite.prepare("update quotes set status = 'sent', deposit_due = 120").run()
    currentDb.sqlite.prepare("update jobs set needed_by = '2099-01-15', window_locked = 1").run()
    await renderProject(jobId, ctx)
    return { ctx, jobId, data }
  }

  it('needs a written reason, then moves to Design and keeps the money on the record', async () => {
    const { ctx, jobId, data } = await atApproval({ sent: true })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /go ahead without acceptance or deposit/i }))
    const go = screen.getByRole('button', { name: /^go ahead$/i }) as HTMLButtonElement
    expect(go.disabled).toBe(true) // no reason, no move
    await user.type(screen.getByLabelText(/why go ahead without/i), 'Repeat client, PO promised Friday')
    await user.click(go)

    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select phase from jobs where id = ?').get(jobId)).toEqual({ phase: 'design' }),
    )
    // Both items skipped with the reason, and the move logged with it.
    const skips = currentDb.sqlite
      .prepare("select item_key, skipped from job_gates where phase = 'approval' and skipped is not null order by item_key")
      .all()
    expect(skips).toEqual([
      { item_key: 'accepted', skipped: 'Repeat client, PO promised Friday' },
      { item_key: 'deposit', skipped: 'Repeat client, PO promised Friday' },
    ])
    await screen.findByText(/Went ahead without acceptance or deposit\. Why: Repeat client/)

    // The board still shows the money -- as a decision, not a red alarm.
    const d = await (data as any).loadProjectDetail(ctx.shop.id, jobId)
    const { flagsFor } = await import('../lib/gates')
    const flags = flagsFor(d.facts)
    expect(flags.find((f) => f.key === 'unagreed')).toMatchObject({ tone: 'warn', label: /by decision/ })
    expect(flags.find((f) => f.key === 'deposit')).toMatchObject({ tone: 'warn', label: /by decision/ })
  })

  it('is not a bypass: an unsent quote still holds it at approval', async () => {
    const { jobId } = await atApproval({ sent: false })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /go ahead without acceptance/i }))
    await screen.findByText(/will not move yet — still open: Quote sent to the client/)
    await user.type(screen.getByLabelText(/why go ahead without/i), 'Verbal yes')
    await user.click(screen.getByRole('button', { name: /^record the reason$/i }))
    await screen.findAllByText(/Skipped — Verbal yes/)
    expect(currentDb.sqlite.prepare('select phase from jobs where id = ?').get(jobId)).toEqual({ phase: 'approval' })
  })
})

describe('Scheduled: pick the machine, check the spool (CG, 8 Oct)', () => {
  it('picking a machine ticks "a machine picked" and goes on the record', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'scheduled')
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    const box = () => document.getElementById('g-printer') as HTMLInputElement
    expect(box().checked).toBe(false)
    await user.selectOptions(screen.getByLabelText(/machine it will run on/i), ctx.printers[0].id)
    await waitFor(() => expect(box().checked).toBe(true))
    expect(box().disabled).toBe(true) // answered by the pick, not a tick
    await screen.findByText(/Nothing else is booked on Prusa XL/)
    await screen.findByText(/Booked on Prusa XL\./)
  })

  it('the material item reads the shelf: short blocks, covered is not yet a tick', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'scheduled')
    // 12 brackets x 62 g = 744 g. Nothing on the shelf yet.
    currentDb.sqlite.prepare('update materials set on_hand = 100').run()
    await renderProject(jobId, ctx)
    const check = await screen.findByTestId('material-check')
    expect(check.textContent).toMatch(/744g/)
    expect(check.textContent).toMatch(/short/)
    expect((document.getElementById('g-material') as HTMLInputElement).checked).toBe(false)
    cleanup()

    currentDb.sqlite.prepare('update materials set on_hand = 2000').run()
    await renderProject(jobId, ctx)
    expect((await screen.findByTestId('material-check')).textContent).toMatch(/covered, not set aside/)
    // Covered is a reading, not a claim -- the tick waits for the hold.
    expect((document.getElementById('g-material') as HTMLInputElement).checked).toBe(false)
  })
})

describe('setting material aside (CG, 8 Oct: the more accurate stock accounting)', () => {
  /** A second project on the same shelf, for the first to compete with. */
  async function second(data: any, ctx: any) {
    const ref = await data.nextJobRef(ctx.shop.id)
    const saved = await data.saveQuote({
      shopId: ctx.shop.id,
      ref,
      client: { name: 'Werft Nord', contact: '', email: '', phone: '', source: '' },
      job: { title: 'Cleats', brief: '', neededBy: null, assetOrigin: 'model' },
      quote: {
        design_billing: 'none', design_qty: 0, revisions_incl: 0, quantity: 10,
        material_id: ctx.materials[0].id, printer_id: ctx.printers[0].id, units_per_part: 50,
        print_hrs_part: 1, finishing_hrs: 0, rush: false, flat_each: 0, discount_pct: 0,
      },
    })
    await data.takeProjectIn(ctx.shop.id, saved.jobId, ctx.profile.id)
    return saved.jobId as string
  }

  it('set aside here is taken from what every other project sees, and only then ticks', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'scheduled')
    currentDb.sqlite.prepare('update materials set on_hand = 1000').run()
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    // 744 g needed, 1000 on hand: covered, but nothing is held yet.
    expect((await screen.findByTestId('material-check')).textContent).toMatch(/covered, not set aside/)
    expect((document.getElementById('g-material') as HTMLInputElement).checked).toBe(false)
    await user.click(screen.getByRole('button', { name: /set aside for this project/i }))
    await waitFor(() => expect((document.getElementById('g-material') as HTMLInputElement).checked).toBe(true))
    expect(screen.getByTestId('material-check').textContent).toMatch(/set aside/)
    await screen.findByText(/Set aside 744g PLA\./)
    cleanup()

    // The second project sees 256 g, not 1000.
    const other = await second(data, ctx)
    await moveTo(data, ctx, other, 'scheduled')
    const { default: Project } = await import('./Project')
    render(
      <MemoryRouter initialEntries={[`/project/${other}`]}>
        <Routes>
          <Route path="/project/:jobId" element={<Project ctx={ctx} />} />
        </Routes>
      </MemoryRouter>,
    )
    const check = await screen.findByTestId('material-check')
    await waitFor(() => expect(check.textContent).toMatch(/744g/))
    expect(check.textContent).toMatch(/256g/) // available
    expect(check.textContent).toMatch(/short 244g/) // 500 needed
  })

  it('a short spool can be stocked right there, then set aside (CG, 8 Oct)', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'scheduled')
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    expect((await screen.findByTestId('material-check')).textContent).toMatch(/short 744g/)
    await user.click(screen.getByRole('button', { name: /add stock of pla/i }))
    await user.type(screen.getByLabelText(/how much came in/i), '1')
    await user.type(screen.getByLabelText(/what you paid, all in/i), '24')
    await user.click(screen.getByRole('button', { name: /add to the shelf/i }))
    await waitFor(() => expect(screen.getByTestId('material-check').textContent).toMatch(/covered, not set aside/))
    await user.click(screen.getByRole('button', { name: /set aside for this project/i }))
    await waitFor(() => expect((document.getElementById('g-material') as HTMLInputElement).checked).toBe(true))
  })

  it('prints draw the hold down, and delivery releases it', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'scheduled')
    currentDb.sqlite.prepare('update materials set on_hand = 1000').run()
    const d = data as any
    await d.setStockHolds(ctx.shop.id, jobId, ctx.profile.id, [{ materialId: ctx.materials[0].id, units: 744 }])
    const held = async () => (await d.listStockHolds(ctx.shop.id)).map((h: any) => [h.held, h.used, h.remaining])
    expect(await held()).toEqual([[744, 0, 744]])
    await d.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, 'building')
    await d.recordPrintRun(ctx.shop.id, jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id, materialId: ctx.materials[0].id, unitsUsed: 300, hours: 5,
      outcome: 'success', failureReason: null, note: null, startedAt: null,
    })
    // 300 g came off the shelf AND off the hold -- never counted twice.
    expect(await held()).toEqual([[744, 300, 444]])
    expect(currentDb.sqlite.prepare('select on_hand from materials').get()).toEqual({ on_hand: 700 })
    await d.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, 'review')
    await d.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, 'delivered')
    expect(await held()).toEqual([])
  })
})

describe('copies, not just parts (CG, 8 Oct: one test plate of five)', () => {
  async function inBuild() {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'building')
    const d = data as any
    // A plate that carries ONE Hull; the job needs five.
    const res = await d.importSlice(ctx.shop.id, jobId, ctx.profile.id, {
      fileName: 'hull.gcode', kind: 'gcode', printerModel: null, printerId: ctx.printers[0].id,
      materialText: 'PLA', materialId: ctx.materials[0].id, estMinutes: 60, estGrams: 20, notes: [],
      sections: [{ label: 'Hull', qty: 1, estMinutes: 60, estGrams: 20, material: 'PLA' }],
    })
    const partId = (currentDb.sqlite.prepare("select id from job_parts where label = 'Hull'").get() as { id: string }).id
    await d.updatePart(ctx.shop.id, partId, { label: 'Hull', qty: 5 }, ctx.profile.id)
    return { ctx, jobId, d, partId, importId: res.importId as string }
  }
  const counts = () =>
    currentDb.sqlite.prepare("select printed_n, passed_n, reprint_n, status from job_parts where label = 'Hull'").get()

  it('one plate of a part that needs five is one of five, not all five', async () => {
    const { ctx, jobId, d, importId } = await inBuild()
    await d.markPlatePrinted(ctx.shop.id, jobId, ctx.profile.id, importId)
    expect(counts()).toEqual({ printed_n: 1, passed_n: 0, reprint_n: 0, status: 'pending' })
  })

  it('print one, fail it, reprint it, then the rest -- all from the row', async () => {
    const { ctx, jobId, partId } = await inBuild()
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    const line = () => screen.getByTestId(`copies-${partId}`).textContent

    // The test plate: asks how many, starting at what one plate holds.
    await user.click(screen.getByRole('button', { name: /^printed hull$/i }))
    const n = screen.getByLabelText(/how many came off/i) as HTMLInputElement
    expect(n.value).toBe('1')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(line()).toBe('1 of 5 printed'))

    // It failed: one copy goes back, with a reason.
    await user.click(screen.getByRole('button', { name: /^fail hull$/i }))
    await user.type(screen.getByLabelText(/what went wrong/i), 'Warped corner')
    await user.click(screen.getByRole('button', { name: /^mark it failed$/i }))
    await waitFor(() => expect(line()).toBe('0 of 5 printed · 1 going back'))
    expect(counts()).toMatchObject({ reprint_n: 1, status: 'reprint' })
    await screen.findByText(/↩ Warped corner/)

    // The reprint and the other four come off: "all".
    await user.click(screen.getByRole('button', { name: /^printed hull$/i }))
    await user.click(screen.getByRole('button', { name: /^all$/i }))
    expect((screen.getByLabelText(/how many came off/i) as HTMLInputElement).value).toBe('5')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(line()).toBe('5 of 5 printed'))
    expect(counts()).toEqual({ printed_n: 5, passed_n: 0, reprint_n: 0, status: 'printed' })
    expect(document.querySelectorAll('.copybar i.on')).toHaveLength(5)
  })

  it('each copy has its own state: copy 3 fails on its own, and a mistake goes back to neutral', async () => {
    const { ctx, jobId, d, partId } = await inBuild()
    await d.movePartCopies(ctx.shop.id, partId, ctx.profile.id, 'printed', 5, null)
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    const line = () => screen.getByTestId(`copies-${partId}`).textContent
    const states = () =>
      JSON.parse((currentDb.sqlite.prepare("select copy_states from job_parts where label = 'Hull'").get() as { copy_states: string }).copy_states)

    await user.click(screen.getByRole('button', { name: /each copy of hull/i }))
    const list = await screen.findByTestId(`each-copy-${partId}`)
    expect(list.textContent).toMatch(/Copy 5/)

    // Copy 3 failed -- asks why, then only copy 3 goes back.
    const copy = (n: number) => within(screen.getByRole('group', { name: new RegExp(`^copy ${n} of hull$`, 'i') }))
    await user.click(copy(3).getByRole('button', { name: 'Failed' }))
    await user.type(screen.getByLabelText(/why did copy 3 fail/i), 'Stringing on the hull')
    await user.click(screen.getByRole('button', { name: /^mark it failed$/i }))
    await waitFor(() => expect(states()).toEqual(['printed', 'printed', 'reprint', 'printed', 'printed']))
    expect(line()).toBe('4 of 5 printed · 1 going back')
    expect(screen.getByTestId(`each-copy-${partId}`).textContent).toMatch(/↩ Stringing on the hull/)

    // Copy 2 was marked printed by mistake: back to neutral, no reason asked.
    await user.click(copy(2).getByRole('button', { name: 'Not printed' }))
    await waitFor(() => expect(states()).toEqual(['printed', 'pending', 'reprint', 'printed', 'printed']))
    expect(line()).toBe('3 of 5 printed · 1 going back')

    // And the whole part back to the start.
    await user.click(screen.getByRole('button', { name: /set every copy back to not printed/i }))
    await waitFor(() => expect(line()).toBe('0 of 5 printed'))
    expect(currentDb.sqlite.prepare("select status from job_parts where label = 'Hull'").get()).toEqual({ status: 'pending' })
  })

  it('the file a copy failed from is not taken as its fix (CG, 9 Oct)', async () => {
    const { ctx, jobId, d, partId } = await inBuild()
    await d.setCopyStates(ctx.shop.id, partId, ctx.profile.id, [0], 'reprint', 'Spaghetti')
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /each copy of hull/i }))
    const same = new File(
      ['; printing object Hull id:0 copy 0\n; total filament used [g] = 20\n; estimated printing time (normal mode) = 1h 0m 0s\n'],
      'hull.gcode',
      { type: 'text/plain' },
    )
    await user.upload(screen.getByLabelText(/new file for copy 1 of hull/i), same)
    expect(await screen.findByText(/the same file the copy failed from/)).toBeDefined()
    const st = JSON.parse((currentDb.sqlite.prepare("select copy_states from job_parts where label = 'Hull'").get() as { copy_states: string }).copy_states)
    expect(st[0]).toBe('reprint')
  })

  it('a failed copy can be skipped, or given a new file and queued again (CG, 8 Oct)', async () => {
    const { ctx, jobId, d, partId } = await inBuild()
    await d.movePartCopies(ctx.shop.id, partId, ctx.profile.id, 'printed', 5, null)
    await d.setCopyStates(ctx.shop.id, partId, ctx.profile.id, [1, 3], 'reprint', 'Warped corner')
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    const states = () =>
      JSON.parse((currentDb.sqlite.prepare("select copy_states from job_parts where label = 'Hull'").get() as { copy_states: string }).copy_states)
    await user.click(screen.getByRole('button', { name: /each copy of hull/i }))

    // Copy 2: a fixed file goes on the part and the copy goes back in the queue.
    const gcode = new File(
      ['; printing object Hull id:0 copy 0\n; total filament used [g] = 18\n; estimated printing time (normal mode) = 0h 55m 0s\n'],
      'hull-fixed.gcode',
      { type: 'text/plain' },
    )
    await user.upload(screen.getByLabelText(/new file for copy 2 of hull/i), gcode)
    await waitFor(() => expect(states()).toEqual(['printed', 'pending', 'printed', 'reprint', 'printed']))
    expect(currentDb.sqlite.prepare("select count(*) as n from slice_imports where file_name = 'hull-fixed.gcode'").get()).toEqual({ n: 1 })
    // The failure stays on the copy, beside the file it is reprinting from,
    // and the plate says whose fix it is (CG, 9 Oct).
    const card2 = (await screen.findByText('Reprint queued')).closest('.copycard') as HTMLElement
    expect(within(card2).getByText(/Failed — Warped corner/)).toBeDefined()
    expect(within(card2).getByText('hull-fixed.gcode')).toBeDefined()
    expect(screen.getByText(/reprint · Hull, copy 2/)).toBeDefined()

    // Copy 4: skipped -- the part needs four now, and it is on the record.
    await user.click(screen.getAllByRole('button', { name: /^skip$/i })[0])
    await user.click(screen.getByRole('button', { name: /^skip copy 4$/i }))
    await waitFor(() => expect(states()).toEqual(['printed', 'pending', 'printed', 'printed']))
    expect(currentDb.sqlite.prepare("select qty from job_parts where label = 'Hull'").get()).toEqual({ qty: 4 })
    await screen.findAllByText(/Copy 4 skipped — not printed again; 4 copies now\./)
  })

  it('plates are recorded in one place, all at once if you like', async () => {
    const { ctx, jobId, d } = await inBuild()
    await d.importSlice(ctx.shop.id, jobId, ctx.profile.id, {
      fileName: 'lid.gcode', kind: 'gcode', printerModel: null, printerId: ctx.printers[0].id,
      materialText: 'PLA', materialId: ctx.materials[0].id, estMinutes: 30, estGrams: 10, notes: [],
      sections: [{ label: 'Lid', qty: 1, estMinutes: 30, estGrams: 10, material: 'PLA' }],
    })
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    expect(screen.queryByRole('region', { name: /from the sliced files/i })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^record all 2$/i }))
    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select count(*) as n from print_runs').get()).toEqual({ n: 2 }),
    )
    // Each plate added the copies it holds: one Hull of five, one Lid of one.
    expect(currentDb.sqlite.prepare("select printed_n from job_parts where label = 'Hull'").get()).toEqual({ printed_n: 1 })
    expect(currentDb.sqlite.prepare("select printed_n from job_parts where label = 'Lid'").get()).toEqual({ printed_n: 1 })
  })

  it('a part cannot be cut below the copies already made', async () => {
    const { ctx, jobId, d, partId, importId } = await inBuild()
    await d.markPlatePrinted(ctx.shop.id, jobId, ctx.profile.id, importId)
    await d.movePartCopies(ctx.shop.id, partId, ctx.profile.id, 'printed', 2, null)
    await expect(d.updatePart(ctx.shop.id, partId, { label: 'Hull', qty: 2 }, ctx.profile.id)).rejects.toThrow(/cannot be fewer than 3/)
  })
})

describe('the build sheet at each stage', () => {
  /** Two Voltage rules, checked on the rendered row rather than in the
   *  helper: the options narrow to the stage, and a reprint's reason is on
   *  the row where the person at the machine will read it. */
  async function withPart(phase: 'scheduled' | 'building' | 'review') {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    const partId = await data.addPart(ctx.shop.id, jobId, ctx.profile.id, {
      label: 'Bearing ring',
      qty: 2,
    })
    for (const to of ['approval', 'design', 'scheduled', 'building', 'review'] as const) {
      if (phase === 'scheduled' && to === 'building') break
      if (phase === 'building' && to === 'review') break
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    return { ctx, jobId, data, partId }
  }

  it('offers nothing to press before In build — a part is still a plan', async () => {
    const { ctx, jobId } = await withPart('scheduled')
    await renderProject(jobId, ctx)
    await screen.findByText('Bearing ring')
    expect(screen.queryByRole('button', { name: /^printed bearing ring$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^fail bearing ring$/i })).toBeNull()
  })

  it('offers printed or fail In build, and pass or fail at Review', async () => {
    const { ctx, jobId, data, partId } = await withPart('building')
    await renderProject(jobId, ctx)
    await screen.findByText('Bearing ring')
    expect(screen.getByRole('button', { name: /^printed bearing ring$/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /^fail bearing ring$/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: /^pass bearing ring$/i })).toBeNull()
    cleanup()
    await data.setPartStatus(ctx.shop.id, partId, ctx.profile.id, 'printed', null)
    await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, 'review')
    await renderProject(jobId, ctx)
    expect(await screen.findByRole('button', { name: /^pass bearing ring$/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /^fail bearing ring$/i })).toBeDefined()
  })

  it('puts the reprint reason on the row, and offers to go back to building', async () => {
    const { ctx, jobId, data, partId } = await withPart('review')
    await data.setPartStatus(ctx.shop.id, partId, ctx.profile.id, 'reprint', 'Layer shift at 40mm')
    await renderProject(jobId, ctx)

    // Not in a drawer somebody has to open.
    await screen.findByText(/Layer shift at 40mm/)
    expect(screen.getByRole('button', { name: /put it back in building/i })).toBeDefined()
  })
})

describe('when printing has to start', () => {
  /** A due date nobody can act on becomes a date they can. The number is
   *  unit-tested in schedule.test.ts; what matters here is that it reaches
   *  the screen at all, which is the failure this repo keeps repeating. */
  it('puts the start date on the project, with what it assumed', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    // 1.75 h a part x 12 = 21 machine hours, collected in person.
    await data.updateProjectFields(ctx.shop.id, jobId, {
      neededBy: '2099-01-20',
      deliveryHow: 'Collected in person',
    })
    await moveTo(data, ctx, jobId, 'scheduled')
    await renderProject(jobId, ctx)

    await screen.findByText(/^Start printing by /)
    expect(screen.getByText(/21 machine hours still to print/)).toBeDefined()
    // The assumptions are printed, not hidden behind the number.
    expect(screen.getByText(/12 machine hours a day/)).toBeDefined()
  })

  it('asks for a delivery date instead of inventing one', async () => {
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'scheduled')
    await renderProject(jobId, ctx)
    await screen.findByText(/Set a delivery date and Guma will say when printing has to start/)
  })
})

describe('a quote can be revised after it was accepted', () => {
  it('offers the revision from the project, pointed at this job', async () => {
    const { ctx, jobId } = await seed({ takeIn: true })
    await renderProject(jobId, ctx)
    const link = (await screen.findByRole('link', { name: /revise the quote/i })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain(`revise=${jobId}`)
  })
})

describe('a long screen folds, and remembers', () => {
  /** jsdom renders the contents of a closed <details> like any other
   *  element, so asserting on the text would prove nothing. The open
   *  attribute is the state that matters. */
  const isOpen = (id: string) =>
    (document.querySelector(`[data-fold="${id}"]`) as HTMLDetailsElement | null)?.open

  it('opens the stage work while the project is live, and keeps the record folded', async () => {
    localStorage.clear()
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'building')
    await renderProject(jobId, ctx)
    expect(isOpen('gate')).toBe(true)
    expect(isOpen('build')).toBe(true)
    expect(isOpen('sofar')).toBe(false)
  })

  it('opens the record once it is delivered, and keeps the money', async () => {
    localStorage.clear()
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'delivered')
    await renderProject(jobId, ctx)
    expect(isOpen('sofar')).toBe(true)
    expect(isOpen('money')).toBe(true)
  })

  it('remembers a section the person folded, per scope', async () => {
    localStorage.clear()
    localStorage.setItem('guma.folds', JSON.stringify({ done: { sofar: false }, live: { gate: false } }))
    const { ctx, jobId, data } = await seed({ takeIn: true })
    await moveTo(data, ctx, jobId, 'delivered')
    await renderProject(jobId, ctx)
    expect(isOpen('sofar')).toBe(false)
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
