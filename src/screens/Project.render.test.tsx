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

  it('the material item reads the shelf: short blocks, covered ticks', async () => {
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
    expect((await screen.findByTestId('material-check')).textContent).toMatch(/covered/)
    expect((document.getElementById('g-material') as HTMLInputElement).checked).toBe(true)
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
