// @vitest-environment jsdom
/**
 * Slicer import, walked the whole way through the screen, against a real
 * database. Nothing below the screen is mocked: @tauri-apps/plugin-sql is
 * node:sqlite, every migration is applied, and the file goes in through the
 * real <input type="file">.
 *
 * It is a render test rather than another unit test because of the two
 * NOT NULL crashes this project has already shipped. Both were payload
 * bugs -- a value the screen sent that the database refused -- and neither
 * was catchable by reading code or by any test that did not walk the screen
 * and look at what came out the other side. importSlice sends a payload
 * built from a parsed file, which is exactly that shape of risk.
 *
 * The other reason: "an estimate is not an actual" is a claim about what
 * the PROJECT shows after an import, not about a function's return value.
 * So it is asserted here, on the rendered screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/** An hours-and-minutes field: the hours box carries the field's label, the minutes box says "(minutes)". */
const hoursBox = (scope: { getByLabelText: typeof screen.getByLabelText }, re: RegExp) =>
  scope.getByLabelText(re, { selector: 'input:not([aria-label$="(minutes)"])' }) as HTMLInputElement
const minutesBox = (scope: { getByLabelText: typeof screen.getByLabelText }, name: string) =>
  scope.getByLabelText(`${name} (minutes)`) as HTMLInputElement


const { DatabaseSync } = (await import(/* @vite-ignore */ ['node', 'sqlite'].join(':'))) as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): {
      run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
      all(...p: unknown[]): unknown[]
      // node:sqlite has get() too; the other render tests do not declare it
      // because they do not use it. The assertions here read single rows.
      get(...p: unknown[]): unknown
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION_SQL = readdirSync(join(here, '../../src-tauri/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '../../src-tauri/migrations', f), 'utf8'))
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

// jsdom does not implement the compression streams. Safari has had both
// since 16.4 and the 3MF parser already depends on DecompressionStream in
// the real app, so borrowing Node's implementation here tests the same
// path rather than a stub.
{
  const web = (await import(/* @vite-ignore */ ['node', 'stream/web'].join(':'))) as {
    CompressionStream?: unknown
    DecompressionStream?: unknown
  }
  const g = globalThis as Record<string, unknown>
  if (!g.CompressionStream && web.CompressionStream) g.CompressionStream = web.CompressionStream
  if (!g.DecompressionStream && web.DecompressionStream) {
    g.DecompressionStream = web.DecompressionStream
  }
}

let currentDb: ReturnType<typeof freshDb>
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => currentDb } }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

/** A shop with one machine whose MODEL matches what the fixture file says,
 *  and one spool of the type it names, so the matcher has something to hit. */
async function seedShop(kind: 'client' | 'inhouse' = 'client') {
  currentDb = freshDb()
  vi.resetModules()
  const data = await import('../lib/data')
  await data.setupShop({
    shop: {
      name: 'Kahului Fab',
      currency: 'USD',
      locale: 'en-US',
      paper: 'letter',
      tax_label: 'GET',
      tax_pct: 4.712,
      state: 'HI',
      quote_valid_days: 30,
      lead_days: 10,
      electricity_rate_kwh: 0.4299,
    },
    rates: {
      design_hourly: 85,
      finishing_hourly: 55,
      rush_pct: 0,
      minimum_order: 0,
      deposit_pct: 0,
      deposit_when: 'design',
      deposit_waive_below: 0,
      material_markup: 1,
      revisions_incl: 0,
      revision_hourly: null,
    },
    printer: {
      name: 'Sakman',
      model: 'Prusa XL',
      tech: 'fdm',
      rate_hourly: 9,
      wear_hourly: 3,
      watts: 340,
    },
    materials: [{ name: 'PETG black', kind: 'PETG', swatch: '#2A3442', unit: 'g', cost_per_unit: 0.025 }],
    fullName: 'CG',
  })
  const ctx = await data.loadShopContext()
  const ref = await data.nextJobRef(ctx.shop.id)
  const saved = await data.saveQuote({
    shopId: ctx.shop.id,
    ref,
    client: { name: 'Reef Watch', contact: '', email: '', phone: '', source: '' },
    job: { title: 'Reef markers', brief: '', neededBy: null, assetOrigin: 'model' },
    quote: {
      design_billing: 'none',
      design_qty: 0,
      revisions_incl: 0,
      quantity: 3,
      material_id: ctx.materials[0].id,
      printer_id: ctx.printers[0].id,
      units_per_part: 30,
      print_hrs_part: 1,
      finishing_hrs: 0,
      rush: false,
      flat_each: 0,
      discount_pct: 0,
    },
  })
  await data.takeProjectIn(ctx.shop.id, saved.jobId, ctx.profile.id)
  // Files are read in and prints recorded where the machines run: In build
  // (stagePlan). Intake shows only the brief and the quote.
  for (const to of ['approval', 'design', 'scheduled', 'building'] as const) {
    await data.updateJobPhase(ctx.shop.id, saved.jobId, ctx.profile.id, to)
  }
  if (kind === 'inhouse') {
    const id = await data.createInHouseJob(ctx.shop.id, { title: 'PETG calibration tower' })
    return { ctx, data, jobId: id }
  }
  return { ctx, data, jobId: saved.jobId }
}

async function renderProject(jobId: string, ctx: unknown) {
  const { default: Project } = await import('./Project')
  render(
    <MemoryRouter initialEntries={[`/project/${jobId}`]}>
      <Routes>
        <Route
          path="/project/:jobId"
          element={<Project ctx={ctx as Parameters<typeof Project>[0]['ctx']} />}
        />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByText('The project so far')
}

/** A PrusaSlicer G-code with two labelled objects, as the slicer writes it. */
const GCODE = `
; printing object Buoy shell id:0 copy 0
; printing object Buoy shell id:0 copy 1
; printing object Cap id:1 copy 0
; filament used [g] = 86.5
; total filament used [g] = 86.5
; estimated printing time (normal mode) = 2h 3m
; filament_type = PETG
; printer_model = XL
`

/** Import the file as an estimate only: untick "Already printed" first. */
async function addAsEstimate(user: ReturnType<typeof userEvent.setup>) {
  const box = await screen.findByRole('checkbox', { name: /already printed/i })
  if ((box as HTMLInputElement).checked) await user.click(box)
  await user.click(await screen.findByRole('button', { name: /add 2 sections/i }))
}

function gcodeFile(name = 'Reef buoy_sliced.gcode') {
  return new File([GCODE], name, { type: 'text/plain' })
}

beforeEach(cleanup)

describe('importing a sliced file from the project screen', () => {
  it('reads the file and shows what is on the plate before writing anything', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())

    // Everything the person needs to judge it, on screen.
    await screen.findByText('Reef buoy_sliced.gcode')
    expect(screen.getByText(/2 sections · 3 copies/)).toBeDefined()
    expect(screen.getByText(/~86\.5 g/)).toBeDefined()
    expect(screen.getByText(/~2h 3m/)).toBeDefined()

    // And nothing is in the build sheet yet.
    expect(screen.queryByRole('button', { name: /^Add 2 sections/i })).toBeDefined()
    expect(currentDb.sqlite.prepare('select count(*) as n from job_parts').get()).toEqual({ n: 0 })
  })

  it('matches the machine and the spool from what the file said', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())

    // "XL" in the file, "Prusa XL" in the shop -- and the label says which
    // word came from the file, so a wrong match is visible rather than
    // silent. That is the Voltage "Pursa XL" lesson.
    const printer = (await screen.findByLabelText(/^machine( —|$)/i)) as HTMLSelectElement
    expect(printer.selectedOptions[0].textContent).toMatch(/Sakman/)
    const material = screen.getByLabelText(/material/i) as HTMLSelectElement
    expect(material.selectedOptions[0].textContent).toMatch(/PETG black/)
  })

  it('writes the build sheet when confirmed, and nothing before', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)

    await waitFor(() => {
      const parts = currentDb.sqlite
        .prepare('select label, qty from job_parts order by sort')
        .all() as { label: string; qty: number }[]
      expect(parts).toEqual([
        { label: 'Buoy shell', qty: 2 },
        { label: 'Cap', qty: 1 },
      ])
    })

    // On the screen, not just in the table.
    const sheet = await screen.findByText('Buoy shell')
    expect(sheet).toBeDefined()
    expect(screen.getByText(/2 parts · 3 copies/)).toBeDefined()
  })

  it('leaves the project cost exactly where it was', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)
    await screen.findByText('Buoy shell')

    // 86.5 g of PETG at $0.025 is $2.16, and 2h 3m on a machine at $9/h
    // with $3/h wear is another $24.60, none of which the shop has spent.
    // If an import ever starts writing a print_run, this is what notices.
    const actuals = currentDb.sqlite
      .prepare('select material_cost, machine_hours, runs from job_actuals where job_id = ?')
      .all(jobId) as Record<string, number>[]
    expect(actuals[0]).toMatchObject({ material_cost: 0, machine_hours: 0, runs: 0 })
  })

  it('refuses binary G-code by name, and writes nothing', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.upload(
      screen.getByLabelText(/import sliced files/i),
      new File(['\x00\x01binary'], 'part.bgcode', { type: 'application/octet-stream' }),
    )

    // The message names the exact PrusaSlicer setting to change, because
    // "unsupported file" would send someone hunting.
    expect((await screen.findAllByText(/binary G-code/i)).length).toBeGreaterThan(0)
    expect(currentDb.sqlite.prepare('select count(*) as n from slice_imports').get()).toEqual({
      n: 0,
    })
  })

  it('discards a file without writing it', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await screen.findByText('Reef buoy_sliced.gcode')

    await user.click(screen.getByRole('button', { name: /discard/i }))

    await waitFor(() => expect(screen.queryByText('Reef buoy_sliced.gcode')).toBeNull())
    expect(currentDb.sqlite.prepare('select count(*) as n from job_parts').get()).toEqual({ n: 0 })
  })

  it('re-importing a fixed file does not duplicate the parts', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)
    await screen.findByText('Buoy shell')

    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile('fixed_v2.gcode'))
    await addAsEstimate(user)

    await waitFor(() => {
      const n = currentDb.sqlite.prepare('select count(*) as n from job_parts').get() as {
        n: number
      }
      // Two parts, not four. The second file's estimate attaches to the
      // parts that already exist -- the reprint case.
      expect(n).toEqual({ n: 2 })
    })
    const imports = currentDb.sqlite.prepare('select count(*) as n from slice_imports').get()
    expect(imports).toEqual({ n: 2 })
  })
})

describe('a shop that has not set up its machines', () => {
  it('still imports, with the machine left unmatched rather than guessed', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    // A machine the shop does not own.
    const other = GCODE.replace('printer_model = XL', 'printer_model = Creality K1')
    await user.upload(
      screen.getByLabelText(/import sliced files/i),
      new File([other], 'k1.gcode', { type: 'text/plain' }),
    )

    const printer = (await screen.findByLabelText(/^machine( —|$)/i)) as HTMLSelectElement
    expect(printer.value).toBe('')
    expect(within(printer).getByText(/not matched/i)).toBeDefined()

    // And it still imports -- an unmatched machine is not a blocked import.
    await addAsEstimate(user)
    await waitFor(() => {
      const row = currentDb.sqlite
        .prepare('select printer_id, printer_model from slice_imports')
        .all() as { printer_id: string | null; printer_model: string }[]
      expect(row[0].printer_id).toBeNull()
      // The file's own word is kept even though nothing matched it.
      expect(row[0].printer_model).toBe('Creality K1')
    })
  })
})

describe("the shop's own work", () => {
  /**
   * The build sheet used to sit inside Project.tsx's `!mine` block, next to
   * money, the promised window and the handover. Those three genuinely do
   * not apply to a trial print. The build sheet does: a prototype has
   * parts, and an R&D print that fails twice has spent material and machine
   * hours exactly as a client's would.
   *
   * The cost of getting that wrong was bigger than a hidden table --
   * slicer import lives on the build sheet, so it was unreachable on
   * precisely the work most likely to be sliced and re-sliced. No test saw
   * it, because every test that touched the build sheet used a client job.
   */
  it('has a build sheet at all', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    await renderProject(jobId, ctx)
    expect(screen.getByRole('heading', { name: /build sheet/i })).toBeDefined()
  })

  it('still hides money and the handover, which really do not apply', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    await renderProject(jobId, ctx)
    // The reason the !mine block exists in the first place -- this change
    // must not have widened it into "show everything".
    expect(screen.queryByRole('heading', { name: /^Money$/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^Handover$/ })).toBeNull()
  })

  it('imports a sliced file onto a trial print, same as any other project', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)

    await waitFor(() => {
      const parts = currentDb.sqlite
        .prepare('select label, qty from job_parts where job_id = ? order by sort')
        .all(jobId) as { label: string; qty: number }[]
      expect(parts).toEqual([
        { label: 'Buoy shell', qty: 2 },
        { label: 'Cap', qty: 1 },
      ])
    })
  })

  it('keeps an imported estimate out of what the trial print actually cost', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)
    await screen.findByText('Buoy shell')

    // In-house work has no quote to compare against, so its actual cost is
    // the only number it has. Polluting that would be worse here, not less
    // bad.
    const a = currentDb.sqlite
      .prepare('select material_cost, machine_hours, runs from job_actuals where job_id = ?')
      .all(jobId) as Record<string, number>[]
    expect(a[0]).toMatchObject({ material_cost: 0, machine_hours: 0, runs: 0 })
  })
})

describe('turning the file into what actually happened', () => {
  /**
   * The gap CG found: "the sliced gcode file should give you the numbers
   * you need to deduct from materials and print hours." Import alone
   * deliberately does not, because an estimate is not an actual -- so the
   * one-click confirm has to exist, and has to be reachable from where the
   * file was dropped.
   */
  it('records the print at import in one step when it already happened (the default)', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    for (const to of ['approval', 'design', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())

    const box = (await screen.findByRole('checkbox', { name: /already printed/i })) as HTMLInputElement
    expect(box.checked).toBe(true)
    const when = screen.getByLabelText(/printed on/i) as HTMLInputElement
    await user.clear(when)
    await user.type(when, '2026-09-20')
    await user.click(screen.getByRole('button', { name: /record the print/i }))

    await waitFor(() => {
      const a = currentDb.sqlite
        .prepare('select material_units, machine_hours, runs from job_actuals where job_id = ?')
        .get(jobId) as Record<string, number>
      expect(a).toMatchObject({ material_units: 87, machine_hours: 2.05, runs: 1 })
    })
    const run = currentDb.sqlite
      .prepare('select started_at, slice_import_id from print_runs')
      .get() as { started_at: string; slice_import_id: string | null }
    expect(run.started_at.slice(0, 10)).toBe('2026-09-20')
    expect(run.slice_import_id).not.toBeNull()
    const m = currentDb.sqlite.prepare('select on_hand from materials').get() as { on_hand: number }
    expect(Number(m.on_hand)).toBe(913)
    const parts = currentDb.sqlite
      .prepare('select status from job_parts order by sort')
      .all() as { status: string }[]
    expect(parts.map((p) => p.status)).toEqual(['printed', 'printed'])
    await screen.findByText(/Recorded as printed on/i)
  })

  it('records the print from the file, deducting the spool and logging the hours', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)

    await user.click(await screen.findByRole('button', { name: /this print happened/i }))

    // Pre-filled from the file: 86.5 g rounds to 87, 2h 3m to 2.05 hours.
    const units = (await screen.findByLabelText(/off the spool/i)) as HTMLInputElement
    expect(units.value).toBe('87')
    // 2h 3m, typed as hours and minutes.
    expect(hoursBox(screen, /^machine time$/i).value).toBe('2')
    expect(minutesBox(screen, 'Machine time').value).toBe('3')

    await user.click(screen.getByRole('button', { name: /^record it$/i }))

    await waitFor(() => {
      const a = currentDb.sqlite
        .prepare('select material_units, machine_hours, runs from job_actuals where job_id = ?')
        .get(jobId) as Record<string, number>
      expect(a).toMatchObject({ material_units: 87, machine_hours: 2.05, runs: 1 })
    })
    const m = currentDb.sqlite.prepare('select on_hand from materials').get() as { on_hand: number }
    expect(Number(m.on_hand)).toBe(913)
    await screen.findByRole('list', { name: /^prints of /i })
  })

  it('asks what went wrong when the print failed, and still bills the material', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)
    await user.click(await screen.findByRole('button', { name: /this print happened/i }))

    await user.selectOptions(await screen.findByLabelText(/how it went/i), 'failed')
    await user.type(await screen.findByLabelText(/what went wrong/i), 'Warped off the plate')
    await user.click(screen.getByRole('button', { name: /^record it$/i }))

    await waitFor(() => {
      const r = currentDb.sqlite
        .prepare('select outcome, failure_reason, units_used from print_runs')
        .get() as Record<string, unknown>
      expect(r).toMatchObject({ outcome: 'failed', failure_reason: 'Warped off the plate' })
      expect(Number(r.units_used)).toBe(87)
    })
    // A failed run burned the filament all the same.
    const m = currentDb.sqlite.prepare('select on_hand from materials').get() as { on_hand: number }
    expect(Number(m.on_hand)).toBe(913)
    await screen.findByRole('button', { name: /print it again/i })
  })
})

describe('the file itself, kept', () => {
  /** CG: "I already uploaded the file that was used to print the piece and
   *  it's not there anymore." It never was -- the import took the numbers
   *  and let the bytes go. */
  it('stores the file with the import, and says so on the row', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    // Said before anything is written, while the file can still be discarded.
    await screen.findByText(/The file itself will be kept with the project/)
    await addAsEstimate(user)

    await waitFor(() => {
      const f = currentDb.sqlite
        .prepare('select byte_size, stored_size, encoding, content from slice_files')
        .get() as Record<string, unknown>
      expect(f).toBeDefined()
      expect(Number(f.byte_size)).toBeGreaterThan(0)
      expect(f.encoding).toBe('gzip-base64')
      expect(String(f.content).length).toBeGreaterThan(0)
    })

    await screen.findByText(/\d+ (B|KB|MB) kept/)
    expect(screen.getByRole('button', { name: /save a copy/i })).toBeDefined()
  })

  it('removes an import without erasing the print that was recorded from it', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    for (const to of ['approval', 'design', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)
    await user.click(await screen.findByRole('button', { name: /this print happened/i }))
    await user.click(screen.getByRole('button', { name: /^record it$/i }))
    await screen.findByRole('list', { name: /^prints of /i })

    await user.click(screen.getByRole('button', { name: /remove the file/i }))
    await screen.findByText(/the print still happened/i)
    await user.click(screen.getByRole('button', { name: /remove it/i }))

    await waitFor(() => {
      const n = currentDb.sqlite.prepare('select count(*) as n from slice_imports').get() as {
        n: number
      }
      expect(n.n).toBe(0)
    })
    const runs = currentDb.sqlite
      .prepare('select slice_import_id from print_runs')
      .all() as { slice_import_id: string | null }[]
    expect(runs).toHaveLength(1)
    expect(runs[0].slice_import_id).toBeNull()
    const files = currentDb.sqlite.prepare('select count(*) as n from slice_files').get() as {
      n: number
    }
    expect(files.n).toBe(0)
  })
})

describe('a plate is one print, and the whole plate comes off it', () => {
  /** The Voltage failure this prevents: the tool reserved and marked parts
   *  one at a time, so a plate of two objects looked like two half-jobs and
   *  the rows sat at "pending" long after the objects were in a box. */
  it('marks every part on the plate printed when the plate is recorded', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    for (const to of ['approval', 'design', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)

    await user.click(await screen.findByRole('button', { name: /this print happened/i }))
    // The offer names the plate, and is on by default.
    const box = (await screen.findByLabelText(/mark the 2 parts on this plate/i)) as HTMLInputElement
    expect(box.checked).toBe(true)
    await user.click(screen.getByRole('button', { name: /^record it$/i }))

    await waitFor(() => {
      const parts = currentDb.sqlite
        .prepare('select label, status from job_parts order by sort')
        .all() as { label: string; status: string }[]
      expect(parts).toEqual([
        { label: 'Buoy shell', status: 'printed' },
        { label: 'Cap', status: 'printed' },
      ])
    })
  })

  it('a failed plate marks the copies it was printing failed, and removing it puts them back (CG, 13 Oct)', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    for (const to of ['approval', 'design', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)
    await user.click(await screen.findByRole('button', { name: /this print happened/i }))
    await user.selectOptions(await screen.findByLabelText(/how it went/i), 'failed')
    // Was: a failed plate left the parts alone. Now its copies fail with it,
    // so the reprint workflow starts on the build sheet.
    const offer = await screen.findByLabelText(/mark the copies this plate was printing as failed/i)
    expect((offer as HTMLInputElement).checked).toBe(true)
    await user.type(await screen.findByLabelText(/what went wrong/i), 'Clog')
    await user.click(screen.getByRole('button', { name: /^record it$/i }))

    await waitFor(() => {
      const n = currentDb.sqlite.prepare("select count(*) as n from job_parts where status = 'reprint'").get() as { n: number }
      expect(n.n).toBe(2)
    })
    const ev = currentDb.sqlite
      .prepare("select note, run_id from part_events where to_status = 'reprint' order by id desc")
      .get() as { note: string; run_id: string | null }
    expect(ev.note).toBe('Clog')
    expect(ev.run_id).not.toBeNull()

    // Removing that print from What it took offers -- ticked -- to put the copies back.
    await user.click(await screen.findByRole('button', { name: /remove the print of/i }))
    const dlg = await screen.findByRole('alertdialog', { name: /remove this print/i })
    expect(within(dlg).getByText(/marked \d+ cop(y|ies) failed on the build sheet/)).toBeDefined()
    await user.click(within(dlg).getByRole('button', { name: /remove it/i }))
    await waitFor(() => {
      const n = currentDb.sqlite.prepare("select count(*) as n from job_parts where status = 'pending'").get() as { n: number }
      expect(n.n).toBe(2)
    })
    expect(currentDb.sqlite.prepare('select count(*) as n from print_runs').get()).toEqual({ n: 0 })
  })
})

describe('a print stopped part way, costed from where it got to (CG, 13 Oct)', () => {
  it('charges what the failed print weighs, plus purge, with the file for reference (CG, 20 Oct)', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    for (const to of ['approval', 'design', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    // The Maui plate: 16h 26m, 354.92 g -- points read from the real file.
    await (data as any).importSlice(ctx.shop.id, jobId, ctx.profile.id, {
      fileName: 'Maui_BATHY_3x.bgcode', kind: 'gcode', printerModel: 'Prusa XL', printerId: ctx.printers[0].id,
      materialText: 'PLA', materialId: ctx.materials[0].id, estMinutes: 986, estGrams: 354.92, notes: [],
      sections: [{ label: 'Maui BATHY 3x', qty: 1, estMinutes: 986, estGrams: 354.92, material: 'PLA' }],
      progress: [
        { min: 0, pct: 0, grams: 0, z: 0, waste: 0 },
        { min: 300, pct: 30, grams: 189.92, z: 13.773, waste: 1.2 },
        { min: 540, pct: 54, grams: 270, z: 29.5, waste: 1.2 },
        { min: 900, pct: 91, grams: 334.16, z: 39.615, waste: 1.2 },
        { min: 985, pct: 100, grams: 354.92, z: 40.315, waste: 1.2 },
      ],
    })
    await renderProject(jobId, ctx)
    await user.click(await screen.findByRole('button', { name: /this print happened/i }))
    await user.selectOptions(await screen.findByLabelText(/how it went/i), 'cancelled')
    await user.type(hoursBox(screen, /machine ran for/i), '15')
    expect((await screen.findByTestId('stopped-at')).textContent).toMatch(/By 15h 0m the plate was 91% through, at layer 39.62 of 40.31 mm; the printer had pushed 334 g, 1.2 g of it purge and skirt/)
    // The purge comes from the file; the weight from the scale.
    expect((screen.getByLabelText(/plus purge and skirt/i) as HTMLInputElement).value).toBe('1.2')
    await user.type(screen.getByLabelText(/the failed print weighs/i), '264')
    expect(screen.getByTestId('stopped-at').textContent).toMatch(/Charged: 265.2 g — the 264 g it weighs plus 1.2 g purge and skirt. The other 69 g the file expected never came out/)
    expect((screen.getByLabelText(/g off the spool/i) as HTMLInputElement).value).toBe('265')
    expect(hoursBox(screen, /^machine time$/i).value).toBe('15')
    expect(minutesBox(screen, 'Machine time').value).toBe('0')
    await user.type(screen.getByLabelText(/what went wrong/i), 'Ghost printing')
    await user.click(screen.getByRole('button', { name: /^record it$/i }))
    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select units_used, hours, outcome, note from print_runs').get()).toEqual({
        units_used: 265,
        hours: 15,
        outcome: 'cancelled',
        note: 'From Maui_BATHY_3x.bgcode — stopped at 15h 0m of 16h 26m (91%, layer 39.62 mm); weighed 264 g + 1.2 g purge and skirt.',
      }),
    )
    // And the copy it was printing is failed, with the reason.
    expect(currentDb.sqlite.prepare("select status from job_parts where label = 'Maui BATHY 3x'").get()).toEqual({ status: 'reprint' })
  })
})

describe('a finished project reads like a record, not a control panel', () => {
  /** CG, on his one finished project: "I don't see a bunch of useful
   *  information there. I don't see the printed file either." */
  it('summarises what it came to, and names the file it was printed from', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    for (const to of ['approval', 'design', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)
    await user.click(await screen.findByRole('button', { name: /this print happened/i }))
    await user.click(screen.getByRole('button', { name: /^record it$/i }))
    await screen.findByRole('list', { name: /^prints of /i })

    for (const to of ['review', 'delivered'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    cleanup()
    // Not renderProject(): that waits for the import box, and a delivered
    // project does not offer one -- which is the point of this screen.
    const { default: Project } = await import('./Project')
    render(
      <MemoryRouter initialEntries={[`/project/${jobId}`]}>
        <Routes>
          <Route
            path="/project/:jobId"
            element={<Project ctx={ctx as Parameters<typeof Project>[0]['ctx']} />}
          />
        </Routes>
      </MemoryRouter>,
    )

    await screen.findByText(/What this project came to/i)
    // The file, by name, with the slicer's numbers against the real ones.
    const printedFrom = await screen.findByText('Printed from')
    expect(printedFrom).toBeDefined()
    expect(screen.getAllByText('Reef buoy_sliced.gcode').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/87 g · 2h 3m/).length).toBeGreaterThan(0)
    // And the money/effort line, not just the controls for work that is over.
    expect(screen.getByText(/machine ·/)).toBeDefined()
  })
})

describe('the import is findable, and says what it did', () => {
  /**
   * "I uploaded a gcode and nothing really happened."
   *
   * The import worked. It was the LAST thing in the build sheet, under the
   * empty-state paragraph and the manual Part/Copies row, and it said
   * nothing after a successful import -- the rows appeared somewhere below
   * the fold and no sentence confirmed the file had been read. Correct
   * behaviour is not the same as visible behaviour, and no test could see
   * the difference because every test queried by label rather than looking
   * at order or feedback.
   */
  it('puts the drop zone before the manual add row, not after it', async () => {
    const { ctx, jobId } = await seedShop()
    await renderProject(jobId, ctx)

    const drop = screen.getByLabelText(/import sliced files/i)
    const manual = screen.getByLabelText(/^part$/i)
    // Node.compareDocumentPosition: 4 means `manual` follows `drop`.
    expect(drop.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('offers a drop target, not just a file button', async () => {
    const { ctx, jobId } = await seedShop()
    await renderProject(jobId, ctx)
    expect(screen.getByText(/drop sliced files here/i)).toBeDefined()
  })

  it('says what it did after importing, in a sentence', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)

    // The thing whose absence read as "nothing happened". It also says
    // the file itself was kept, which is the other half of the answer.
    await screen.findByText(/Reef buoy_sliced\.gcode — 2 parts added, file kept\./i)
  })

  it('says when a re-import updated parts rather than adding them', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)
    await screen.findByText('Buoy shell')

    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile('fixed_v2.gcode'))
    await addAsEstimate(user)

    // Nothing was added, and saying "2 parts added" would be a lie that
    // sends someone looking for rows that are not there.
    await screen.findByText(/2 already on the sheet, estimate updated/i)
  })
})

describe('what is blocking the stage', () => {
  it('names the outstanding items and counts them, above the list', async () => {
    const { ctx, jobId } = await seedShop()
    await renderProject(jobId, ctx)

    // A fresh project has not cleared its gate, so there is something to say.
    const bar = await screen.findByText(/thing(s)? left before/i)
    expect(bar).toBeDefined()
    const list = bar.closest('.blockbar')?.querySelectorAll('li') ?? []
    expect(list.length).toBeGreaterThan(0)
  })

  it('marks each unticked item and leaves the ticked ones quiet', async () => {
    const { ctx, jobId } = await seedShop()
    await renderProject(jobId, ctx)

    const todo = document.querySelectorAll('.gwrap.todo')
    expect(todo.length).toBeGreaterThan(0)
    // Every marked row carries a chip saying which kind of outstanding it
    // is -- something to do, or something to wait on.
    for (const row of todo) expect(row.querySelector('.todo-chip')).not.toBeNull()
  })
})

describe('a failed part, Voltage-style', () => {
  it('asks why and how to fix it, takes the fixed file, and keeps the tally', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    for (const to of ['approval', 'design', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await user.click(await screen.findByRole('button', { name: /record the print/i }))
    await screen.findByText(/Recorded as printed on/i)

    const row = (await screen.findByText('Buoy shell')).closest('tr')!
    await user.click(within(row).getByRole('button', { name: /^fail buoy shell$/i }))
    const send = screen.getByRole('button', { name: /mark it failed/i })
    expect((send as HTMLButtonElement).disabled, 'a reason is required').toBe(true)
    await user.type(screen.getByLabelText(/what went wrong/i), 'Warped corner')
    await user.type(screen.getByLabelText(/how to get it right/i), 'Brim on, dry the spool')
    await user.upload(screen.getByLabelText(/fixed file/i), gcodeFile('Reef buoy_v2.gcode'))
    await user.click(send)

    await waitFor(() => {
      const ev = currentDb.sqlite
        .prepare("select note from part_events where to_status = 'reprint'")
        .get() as { note: string } | undefined
      expect(ev?.note).toBe('Warped corner · Fix: Brim on, dry the spool · Fixed file: Reef buoy_v2.gcode')
    })
    // The fixed file is kept and matched to the existing parts, not duplicated.
    expect(currentDb.sqlite.prepare('select count(*) as n from slice_imports').get()).toEqual({ n: 2 })
    expect(currentDb.sqlite.prepare('select count(*) as n from job_parts').get()).toEqual({ n: 2 })
    // No separate failures line (CG, 20 Oct): the failure is on the part's copy.
    expect(screen.queryByRole('note', { name: /failures on this project/i })).toBeNull()
  })
})

describe("CG's Maui: one G-code uploaded several times, project at Made", () => {
  it('shows the file once under What it actually took, and one click records it', async () => {
    const { ctx, jobId, data } = await seedShop('inhouse')
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    // How his data looks: the same file imported three times, each as an
    // estimate (before import could record a print), then moved to Done.
    const parsed = await (await import('../lib/sliceImport')).parseSliceFile(gcodeFile('Maui bathy.gcode'))
    const input = {
      fileName: parsed.fileName,
      kind: parsed.kind,
      printerModel: parsed.printerModel,
      printerId: null,
      materialText: parsed.totals.material,
      materialId: ctx.materials[0].id,
      estMinutes: parsed.totals.estMinutes,
      estGrams: parsed.totals.estGrams,
      notes: parsed.notes,
      sections: parsed.sections,
    }
    for (let i = 0; i < 3; i++) {
      currentDb.sqlite
        .prepare(
          `insert into slice_imports (id, shop_id, job_id, file_name, kind, printer_model, material_id, est_minutes, est_grams, notes, imported_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
        )
        .run(`old-${i}`, ctx.shop.id, jobId, input.fileName, input.kind, input.printerModel, input.materialId, input.estMinutes, input.estGrams, `2026-09-2${i}T10:00:00Z`)
    }
    for (const to of ['review'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }

    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    // One place to record a plate: the build sheet's Plates list (CG, 8 Oct).
    const region = await screen.findByRole('region', { name: /^plates$/i })
    expect(region.closest('details')?.hasAttribute('open')).toBe(true)
    expect(within(region).getAllByText('Maui bathy.gcode')).toHaveLength(1)
    within(region).getByText(/uploaded 3 times — counted once/i)
    within(region).getByText(/~87 g/)
    expect(screen.queryByRole('region', { name: /from the sliced files/i })).toBeNull()

    // One machine in the shop, so it is already picked.
    await user.click(within(region).getByRole('button', { name: /this print happened/i }))
    expect((screen.getByLabelText(/^machine$/i) as HTMLSelectElement).value).toBe(ctx.printers[0].id)
    await user.click(within(region).getByRole('button', { name: /^record it$/i }))
    await waitFor(() => {
      const a = currentDb.sqlite
        .prepare('select material_units, machine_hours, runs from job_actuals where job_id = ?')
        .get(jobId) as Record<string, number>
      expect(a).toMatchObject({ material_units: 87, machine_hours: 2.05, runs: 1 })
    })
    await within(region).findByRole('list', { name: /^prints of /i })

    // Uploading it yet again, at Done, adds nothing and counts nothing twice.
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile('Maui bathy.gcode'))
    await user.click(await screen.findByRole('button', { name: /record the print/i }))
    await screen.findByText(/not added again/i)
    expect(currentDb.sqlite.prepare('select count(*) as n from slice_imports').get()).toEqual({ n: 3 })
    expect(currentDb.sqlite.prepare('select count(*) as n from print_runs').get()).toEqual({ n: 1 })
  })
})

describe('moving a project backwards', () => {
  it('is offered beside the stages on a Done project, needs a reason, and logs it', async () => {
    const { ctx, jobId, data } = await seedShop('inhouse')
    for (const to of ['review', 'delivered'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await data.archiveProject(ctx.shop.id, jobId, ctx.profile.id, true)
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.click(await screen.findAllByRole('button', { name: /move back a stage/i }).then((b) => b[0]))
    // Every earlier stage can be chosen, the nearest first-selected.
    const to = screen.getByLabelText(/^move back to$/i) as HTMLSelectElement
    expect(to.value).toBe('review')
    await user.selectOptions(to, 'design')
    const move = screen.getByRole('button', { name: /^move back to working/i })
    expect((move as HTMLButtonElement).disabled, 'a reason is required').toBe(true)
    await user.type(screen.getByLabelText(/what needs fixing/i), 'Coastline off by a layer')
    await user.click(move)

    await waitFor(() => {
      const j = currentDb.sqlite.prepare('select phase, archived_at from jobs where id = ?').get(jobId) as {
        phase: string
        archived_at: string | null
      }
      expect(j).toEqual({ phase: 'design', archived_at: null })
    })
    await screen.findByText(/Moved back from .* to .*\. Why: Coastline off by a layer/)
  })
})

describe('adding parts after the sheet was checked', () => {
  it('lets a project at Made take another piece, with a reason in Activity', async () => {
    const { ctx, jobId, data } = await seedShop('inhouse')
    await data.addPart(ctx.shop.id, jobId, ctx.profile.id, { label: 'Maui Top', qty: 1 })
    for (const to of ['review'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.click(await screen.findByRole('button', { name: /a part with no file/i }))
    await user.type(await screen.findByLabelText(/add another part/i), 'Maui Base')
    const add = screen.getByRole('button', { name: /^add$/i })
    expect((add as HTMLButtonElement).disabled, 'a reason is required').toBe(true)
    await user.type(screen.getByLabelText(/why, now it has been checked/i), 'Base plate for the display')
    await user.click(add)
    await waitFor(() => {
      const parts = currentDb.sqlite.prepare('select label, status from job_parts order by sort').all()
      expect(parts).toEqual([
        { label: 'Maui Top', status: 'pending' },
        { label: 'Maui Base', status: 'pending' },
      ])
    })
    await screen.findByText(/Added a part, "Maui Base" ×1\. Why: Base plate for the display/)
  })
})

describe('an import that cannot be saved', () => {
  it('says so inside the import box, not only at the top of the page', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    const bad = new File(['\x00\x01binary'], 'part.bgcode', { type: 'application/octet-stream' })
    await user.upload(screen.getByLabelText(/import sliced files/i), bad)
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((a) => /not imported/i.test(a.textContent ?? ''))).toBe(true)
  })
})

describe('a kept 3MF that was imported with no numbers', () => {
  it('can be read again, and then fills the print in', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const { zipBytes } = await import('../lib/testZip')
    const { packFile } = await import('../lib/sliceFile')
    const bytes = zipBytes({
      'Metadata/slice_info.config':
        '<config><plate><metadata key="index" value="1"/><object identify_id="1" name="Maui Top" skipped="false"/><filament id="1" type="PETG"/></plate></config>',
      'Metadata/plate_1.gcode':
        '; model printing time: 6h 50m; total estimated time: 7h 2m 13s\n; total filament weight [g] : 212.45\n',
    })
    const kept = await packFile(bytes)
    // How CG's row looks today: imported by the old reader, numbers empty.
    currentDb.sqlite
      .prepare(
        `insert into slice_imports (id, shop_id, job_id, file_name, kind, printer_id, material_id, est_minutes, est_grams, notes)
         values ('old', ?, ?, 'Sliced_Maui_Top.3mf', '3mf', ?, ?, null, null, '[]')`,
      )
      .run(ctx.shop.id, jobId, ctx.printers[0].id, ctx.materials[0].id)
    currentDb.sqlite
      .prepare('insert into slice_files (import_id, byte_size, stored_size, encoding, content) values (?, ?, ?, ?, ?)')
      .run('old', kept!.byteSize, kept!.storedSize, kept!.encoding, kept!.content)

    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.click(await screen.findByRole('button', { name: /read it again/i }))

    await waitFor(() => expect(screen.getByRole('region', { name: /^plates$/i }).textContent).toMatch(/~212 g/))
    const region = screen.getByRole('region', { name: /^plates$/i })
    expect(currentDb.sqlite.prepare('select count(*) as n from slice_imports').get()).toEqual({ n: 1 })
    await user.click(within(region).getByRole('button', { name: /this print happened/i }))
    await user.click(within(region).getByRole('button', { name: /^record it$/i }))
    await waitFor(() => {
      const a = currentDb.sqlite
        .prepare('select material_units, machine_hours, runs from job_actuals where job_id = ?')
        .get(jobId) as Record<string, number>
      expect(a).toMatchObject({ material_units: 212, machine_hours: 7.03, runs: 1 })
    })
  })
})

describe("CG's PrusaSlicer .bgcode, imported and recorded", () => {
  it('fills the run from the binary file and takes the filament off the shelf', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    const bytes = readFileSync(join(here, '../../samples/maui-top_prusa-xl.bgcode'))
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(
      screen.getByLabelText(/import sliced files/i),
      new File([bytes], 'Maui_Top_2mm Base.bgcode', { type: 'application/octet-stream' }),
    )
    // Matched to the shop's Prusa XL, ticked as already printed.
    expect(((await screen.findByLabelText(/^machine/i)) as HTMLSelectElement).value).toBe(ctx.printers[0].id)
    // The shop's only spool here is PETG; the file says PLA, so it is left
    // for the person to pick rather than guessed.
    const mat = screen.getByLabelText(/^material — file says “PLA”/i) as HTMLSelectElement
    expect(mat.value).toBe('')
    await user.selectOptions(mat, ctx.materials[0].id)
    await user.click(screen.getByRole('button', { name: /record the print/i }))
    await waitFor(() => {
      const a = currentDb.sqlite
        .prepare('select material_units, machine_hours, runs from job_actuals where job_id = ?')
        .get(jobId) as Record<string, number>
      expect(a).toMatchObject({ material_units: 73, machine_hours: 7.57, runs: 1 })
    })
    const m = currentDb.sqlite.prepare('select on_hand from materials').get() as { on_hand: number }
    expect(Number(m.on_hand)).toBe(927)
  })
})

describe('removing a part that is wrong', () => {
  it('asks first, removes it, and records it in Activity', async () => {
    const { ctx, jobId, data } = await seedShop('inhouse')
    await data.addPart(ctx.shop.id, jobId, ctx.profile.id, { label: 'Maui Top', qty: 1 })
    await data.addPart(ctx.shop.id, jobId, ctx.profile.id, { label: 'Wrong piece', qty: 2 })
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.click(await screen.findByRole('button', { name: /^remove wrong piece$/i }))
    // Nothing gone until it is confirmed.
    expect(currentDb.sqlite.prepare('select count(*) as n from job_parts').get()).toEqual({ n: 2 })
    await user.click(screen.getByRole('button', { name: /^remove it$/i }))
    await waitFor(() => {
      const parts = currentDb.sqlite.prepare('select label from job_parts').all()
      expect(parts).toEqual([{ label: 'Maui Top' }])
    })
    await screen.findByText(/Removed part "Wrong piece" ×2\./)
  })

  it('works on a project at Made too, with a reason', async () => {
    const { ctx, jobId, data } = await seedShop('inhouse')
    await data.addPart(ctx.shop.id, jobId, ctx.profile.id, { label: 'Maui Top', qty: 1 })
    await data.addPart(ctx.shop.id, jobId, ctx.profile.id, { label: 'Duplicate', qty: 1 })
    for (const to of ['review'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.click(await screen.findByRole('button', { name: /^remove duplicate$/i }))
    const go = screen.getByRole('button', { name: /^remove it$/i })
    expect((go as HTMLButtonElement).disabled, 'a reason is required').toBe(true)
    await user.type(screen.getByLabelText(/why\? \(required/i), 'Imported twice')
    await user.click(go)
    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select count(*) as n from job_parts').get()).toEqual({ n: 1 }),
    )
    await screen.findByText(/Removed part "Duplicate" ×1\. Why: Imported twice/)
  })
})


describe('failing one part of a plate, and swapping in its fixed file', () => {
  it('links a one-object reprint file to that part, and recording it marks the part reprinted', async () => {
    const { ctx, jobId, data } = await seedShop()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    // The plate prints, In build.
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await user.click(await screen.findByRole('button', { name: /record the print/i }))
    await screen.findByText(/Recorded as printed on/i)

    // Checking happens at Review: Cap passes, one Buoy shell came off warped.
    await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, 'review')
    cleanup()
    await renderProject(jobId, ctx)
    await user.click(await screen.findByRole('button', { name: /^pass cap$/i }))
    await user.click(await screen.findByRole('button', { name: /^fail buoy shell$/i }))
    await user.type(screen.getByLabelText(/what went wrong/i), 'Warped corner')
    // The fix, sliced on its own, under whatever name the slicer used.
    const fixed = new File(
      ['; printing object shell_v2 id:0 copy 0\n; total filament used [g] = 31\n; estimated printing time (normal mode) = 50m\n; printer_model = XL\n'],
      'buoy shell fixed.gcode',
      { type: 'text/plain' },
    )
    await user.upload(screen.getByLabelText(/fixed file/i), fixed)
    await user.click(screen.getByRole('button', { name: /mark it failed/i }))

    await waitFor(() => {
      const parts = currentDb.sqlite.prepare('select label, status from job_parts order by sort').all()
      // No "shell v2" row: the file belongs to the failed part.
      expect(parts).toEqual([
        { label: 'Buoy shell', status: 'reprint' },
        { label: 'Cap', status: 'passed' },
      ])
    })
    const shell = currentDb.sqlite
      .prepare("select p.chosen_section_id, s.est_grams from job_parts p join slice_sections s on s.id = p.chosen_section_id where p.label = 'Buoy shell'")
      .get() as { est_grams: number } | undefined
    expect(shell?.est_grams).toBe(31)

    // The reprint comes off: recording the fixed file marks the part printed.
    const row = (await screen.findAllByText('buoy shell fixed.gcode'))
      .map((el) => el.closest('.pane') as HTMLElement | null)
      .find((el) => el && within(el).queryByRole('button', { name: /this print happened/i }))!
    await user.click(within(row).getByRole('button', { name: /this print happened/i }))
    await user.click(await screen.findByRole('button', { name: /^record it$/i }))
    await waitFor(() => {
      const p = currentDb.sqlite.prepare("select status from job_parts where label = 'Buoy shell'").get()
      expect(p).toEqual({ status: 'printed' })
    })
    // Both prints are in the cost: the failed plate's filament was really used.
    const a = currentDb.sqlite.prepare('select runs, material_units from job_actuals where job_id = ?').get(jobId)
    expect(a).toEqual({ runs: 2, material_units: 87 + 31 })
  })
})

describe('a plate imported before Guma read the moves (CG, 13 Oct)', () => {
  it('reads the kept file once, saves its progress, and then costs the stop from it -- in Working', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const { packFile } = await import('../lib/sliceFile')
    const gcode = [
      'M83',
      'M73 P0 R100',
      'G1 Z0.2',
      'G1 X1 Y1 E5000',
      'M73 P40 R60',
      'G1 Z5',
      'G1 X2 Y2 E1000',
      'M73 P100 R0',
      '; total filament used [g] = 72.00',
      '; estimated printing time (normal mode) = 1h 40m 0s',
    ].join('\n')
    const kept = await packFile(new TextEncoder().encode(gcode))
    currentDb.sqlite
      .prepare(
        `insert into slice_imports (id, shop_id, job_id, file_name, kind, printer_id, material_id, est_minutes, est_grams, notes)
         values ('old', ?, ?, 'lid.gcode', 'gcode', ?, ?, 100, 72, '[]')`,
      )
      .run(ctx.shop.id, jobId, ctx.printers[0].id, ctx.materials[0].id)
    currentDb.sqlite
      .prepare('insert into slice_files (import_id, byte_size, stored_size, encoding, content) values (?, ?, ?, ?, ?)')
      .run('old', kept!.byteSize, kept!.storedSize, kept!.encoding, kept!.content)

    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    const region = screen.getByRole('region', { name: /^plates$/i })
    await user.click(await within(region).findByRole('button', { name: /this print happened/i }))
    await user.selectOptions(within(region).getByLabelText(/how it went/i), 'failed')
    await user.click(within(region).getByRole('button', { name: /read the file to see where it stopped/i }))
    await within(region).findAllByLabelText(/machine ran for/i)
    await user.type(minutesBox(within(region), 'Machine ran for'), '40')
    // 5000 of 6000 mm by minute 40, scaled to the slicer's 72 g: 60 g. A
    // straight line would have said 28.8 g.
    expect(within(region).getByTestId('stopped-at').textContent).toMatch(/40% through, at layer 0.20 of 5.00 mm; the printer had pushed 60 g/)
    expect(currentDb.sqlite.prepare("select progress is not null as kept from slice_imports where id = 'old'").get()).toEqual({ kept: 1 })
  })
})

describe('a print recorded as clean that had stopped part way (CG, 14 Oct)', () => {
  const MAUI_PROGRESS = [
    { min: 0, pct: 0, grams: 0, z: 0 },
    { min: 300, pct: 30, grams: 189.92, z: 13.773 },
    { min: 540, pct: 54, grams: 270, z: 29.5 },
    { min: 900, pct: 91, grams: 334.16, z: 39.615 },
    { min: 985, pct: 100, grams: 354.92, z: 40.315 },
  ]

  it('the plate says it disagrees with the build sheet, and the print is corrected in place', async () => {
    const { ctx, jobId, data } = await seedShop()
    const d = data as any
    for (const to of ['approval', 'design', 'scheduled', 'building'] as const) await d.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    const imp = await d.importSlice(ctx.shop.id, jobId, ctx.profile.id, {
      fileName: 'Sliced_Maui_16h26m.bgcode', kind: 'gcode', printerModel: 'Prusa XL', printerId: ctx.printers[0].id,
      materialText: 'PLA', materialId: ctx.materials[0].id, estMinutes: 986, estGrams: 354.92, notes: [],
      sections: [{ label: 'Maui BATHY 3x', qty: 1, estMinutes: 986, estGrams: 354.92, material: 'PLA' }],
      progress: MAUI_PROGRESS,
    })
    // How CG's plate stands: recorded clean at upload, then the copy failed by hand.
    const run = await d.recordPrintRun(ctx.shop.id, jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id, materialId: ctx.materials[0].id, unitsUsed: 355, hours: 16.43, outcome: 'success',
      failureReason: null, note: null, startedAt: '2026-10-14', sliceImportId: imp.importId,
    })
    await d.markPlatePrinted(ctx.shop.id, jobId, ctx.profile.id, imp.importId, run)
    const partId = (currentDb.sqlite.prepare('select id from job_parts').get() as { id: string }).id
    await d.setCopyStates(ctx.shop.id, partId, ctx.profile.id, [0], 'reprint', 'Started ghost printing')

    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    const nudge = await screen.findByTestId(`plate-disagrees-${imp.importId}`)
    expect(nudge.textContent).toMatch(/Recorded as coming off clean, but Maui BATHY 3x has a copy marked failed since/)
    await user.click(within(nudge).getByRole('button', { name: /correct this print/i }))

    expect(await screen.findByText(/Correcting the print recorded 2026-10-14/)).toBeDefined()
    expect((screen.getByLabelText(/how it went/i) as HTMLSelectElement).value).toBe('cancelled')
    await user.type(hoursBox(screen, /machine ran for/i), '15')
    await user.type(screen.getByLabelText(/the failed print weighs/i), '264')
    const why = screen.getByLabelText(/what went wrong/i)
    await user.clear(why)
    await user.type(why, 'Ghost printing — Nextruder motor')
    await user.click(screen.getByRole('button', { name: /save the correction/i }))

    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select units_used, hours, outcome, failure_reason from print_runs').get()).toEqual({
        units_used: 264,
        hours: 15,
        outcome: 'cancelled',
        failure_reason: 'Ghost printing — Nextruder motor',
      }),
    )
    // 91 g back on the shelf -- it weighed 264 g, not 355 -- and still only one run.
    expect(currentDb.sqlite.prepare('select on_hand from materials').get()).toEqual({ on_hand: 736 })
    expect(currentDb.sqlite.prepare('select count(*) as n from print_runs').get()).toEqual({ n: 1 })
    await waitFor(() => expect(screen.queryByTestId(`plate-disagrees-${imp.importId}`)).toBeNull())
  })

  it('at upload, "Stopped part way" asks where it got to and records that', async () => {
    const { ctx, jobId, data } = await seedShop()
    for (const to of ['approval', 'design', 'scheduled', 'building'] as const) await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    await renderProject(jobId, ctx)
    const user = userEvent.setup()
    const gcode = [
      'M83', '; printing object Lid id:0 copy 0', 'M73 P0 R100', 'G1 Z0.2', 'G1 X1 Y1 E5000', 'M73 P40 R60',
      'G1 Z5', 'G1 X2 Y2 E1000', '; stop printing object Lid id:0 copy 0', 'M73 P100 R0',
      '; total filament used [g] = 72.00', '; estimated printing time (normal mode) = 1h 40m 0s', '; filament_type = PLA',
    ].join('\n')
    await user.upload(screen.getByLabelText(/import sliced files/i), new File([gcode], 'lid.gcode', { type: 'text/plain' }))
    await user.selectOptions(await screen.findByLabelText(/how it went/i), 'cancelled')
    await user.selectOptions(document.getElementById('slice-material') as HTMLSelectElement, ctx.materials[0].id)
    const pickMachine = document.getElementById('slice-printer') as HTMLSelectElement
    if (!pickMachine.value) await user.selectOptions(pickMachine, ctx.printers[0].id)
    expect((screen.getByRole('button', { name: /say how long it ran/i }) as HTMLButtonElement).disabled).toBe(true)
    await user.type(screen.getByLabelText(/what went wrong/i), 'Clog')
    await user.type(minutesBox(screen, 'Machine ran for'), '40')
    await user.click(screen.getByRole('button', { name: /record where it stopped/i }))
    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select units_used, hours, outcome, failure_reason from print_runs').get()).toEqual({
        units_used: 60,
        hours: 0.67,
        outcome: 'cancelled',
        failure_reason: 'Clog',
      }),
    )
    expect(currentDb.sqlite.prepare("select status from job_parts where label = 'Lid'").get()).toEqual({ status: 'reprint' })
  })
})

/** A second plate: another object, its own numbers. */
const CAP_GCODE = `
; printing object Spare cap id:0 copy 0
; filament used [g] = 12.0
; total filament used [g] = 12.0
; estimated printing time (normal mode) = 0h 41m
; filament_type = PETG
; printer_model = XL
`

describe('several files at once, and each print said once (CG, 15 Oct)', () => {
  it('reads every file dropped, reviews each, and adds them all together', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), [
      gcodeFile(),
      new File([CAP_GCODE], 'Spare cap.gcode', { type: 'text/plain' }),
    ])
    expect(await screen.findByText(/2 files read/i)).toBeDefined()
    expect(screen.getByRole('group', { name: /review reef buoy_sliced\.gcode/i })).toBeDefined()
    const cap = screen.getByRole('group', { name: /review spare cap\.gcode/i })
    // Each file has its own answers: the cap is still to print.
    await user.click(within(cap).getByRole('checkbox', { name: /already printed/i }))
    await user.click(screen.getByRole('button', { name: /^add all 2$/i }))

    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select count(*) as n from slice_imports').get()).toEqual({ n: 2 }),
    )
    expect(currentDb.sqlite.prepare('select count(*) as n from print_runs').get()).toEqual({ n: 1 })
    // The print sits under its own plate, once -- and What it took adds it
    // up rather than listing it again.
    const plates = await screen.findByRole('region', { name: /^plates$/i })
    const prints = await within(plates).findByRole('list', { name: /prints of reef buoy_sliced\.gcode/i })
    expect(within(prints).getByText(/came off clean · 2h 3m · 87 g/)).toBeDefined()
    expect(screen.getAllByText(/came off clean · 2h 3m/)).toHaveLength(1)
    expect(screen.getByTestId('took-totals').textContent).toMatch(/1 print · all listed under their plates/)
    expect(within(plates).getAllByText('not printed yet')).toHaveLength(1)
    expect(within(plates).getByText('Buoy shell ×2, Cap')).toBeDefined()
  })

  it('counts the same file dropped twice in one go as one plate and one print', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), [gcodeFile(), gcodeFile('Reef buoy_sliced (1).gcode')])
    expect(await screen.findByText(/already in this batch/i)).toBeDefined()
    await user.click(screen.getByRole('button', { name: /^add all 2$/i }))
    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select count(*) as n from slice_imports').get()).toEqual({ n: 1 }),
    )
    expect(currentDb.sqlite.prepare('select count(*) as n from print_runs').get()).toEqual({ n: 1 })
  })

  it('names a plate that printed a failed copy as its reprint', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    // The first plate failed...
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await user.selectOptions(await screen.findByLabelText(/how it went/i), 'failed')
    await user.type(screen.getByLabelText(/what went wrong/i), 'Clog')
    await user.type(hoursBox(screen, /machine ran for/i), '1')
    await user.type(screen.getByLabelText(/the failed print weighs/i), '40')
    await user.click(screen.getByRole('button', { name: /record where it stopped/i }))
    await screen.findByText('failed')
    // ...and a re-sliced file printed its copies.
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile('Reef buoy v2.gcode'))
    await user.click(await screen.findByRole('button', { name: /record the print/i }))
    const plates = await screen.findByRole('region', { name: /^plates$/i })
    expect(await within(plates).findByText(/reprint · Buoy shell, copy 1 & 2; Cap, copy 1/)).toBeDefined()
    const failedPrints = within(plates).getByRole('list', { name: /prints of reef buoy_sliced\.gcode/i })
    expect(within(failedPrints).getByText(/failed · /)).toBeDefined()
    expect(within(failedPrints).getByText('Clog')).toBeDefined()
    expect(screen.getByTestId('took-totals').textContent).toMatch(/Lost to failures/)
  })
})

/** The same object name as GCODE's "Cap", a quarter of the size. */
const SMALL_CAP = `
; printing object Cap id:0 copy 0
; filament used [g] = 7.0
; total filament used [g] = 7.0
; estimated printing time (normal mode) = 0h 10m
; filament_type = PETG
; printer_model = XL
`

describe('sorting the objects in a file onto parts (CG, 16 Oct)', () => {
  it('does not put a same-named object of a different size on the old part without asking', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await user.click(await screen.findByRole('button', { name: /record the print/i }))
    await screen.findByRole('list', { name: /prints of reef buoy_sliced/i })

    await user.upload(screen.getByLabelText(/import sliced files/i), new File([SMALL_CAP], 'Sliced_Small cap_0.4n_0.2mm_PETG_XL_10m.gcode'))
    // Guessed as a new part, named for the file, and the screen says why.
    const name = (await screen.findByLabelText(/name the new part for cap/i)) as HTMLInputElement
    expect(name.value).toBe('Small cap')
    expect(screen.getByText(/Same name as Cap \(29 g, 41m a copy\), but this is 7 g, 10m/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: /record the print/i }))
    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select label from job_parts order by sort').all()).toEqual([
        { label: 'Buoy shell' },
        { label: 'Cap' },
        { label: 'Small cap' },
      ]),
    )
    // The plate is named for what it makes.
    const plates = screen.getByRole('region', { name: /^plates$/i })
    expect(await within(plates).findByText('Small cap')).toBeDefined()
  })

  it('moves an object already imported to the right part, and its printed copy with it', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    // Put on the old part by hand, the way name-matching used to.
    await user.click(await screen.findByRole('button', { name: /record the print/i }))
    await screen.findByRole('list', { name: /prints of reef buoy_sliced/i })
    await user.upload(screen.getByLabelText(/import sliced files/i), new File([SMALL_CAP], 'small.gcode'))
    await user.selectOptions(await screen.findByLabelText(/where cap goes/i), screen.getByRole('option', { name: /^Cap · / }))
    await user.click(screen.getByRole('button', { name: /record the print/i }))
    await screen.findByRole('list', { name: /prints of small\.gcode/i })
    const cap = () => currentDb.sqlite.prepare("select copy_states from job_parts where label = 'Cap'").get() as { copy_states: string }
    // Cap needed one copy; the reef plate printed it, so the small plate had none left to mark.
    expect(JSON.parse(cap().copy_states)).toEqual(['printed'])

    // Sorted: the small plate's object is its own part.
    const plates = screen.getByRole('region', { name: /^plates$/i })
    await user.click(within(plates).getByRole('button', { name: /^sort parts of small\.gcode$/i }))
    const box = await screen.findByRole('group', { name: /sort the parts of small\.gcode/i })
    await user.selectOptions(within(box).getByLabelText(/where cap goes/i), 'new')
    const nm = within(box).getByLabelText(/name the new part for cap/i)
    await user.clear(nm)
    await user.type(nm, 'Small cap')
    await user.click(within(box).getByRole('button', { name: /save the sorting/i }))
    expect(await screen.findByText(/Cap: Cap → Small cap \(1 copy moved with it\)/)).toBeDefined()
    const small = currentDb.sqlite.prepare("select copy_states from job_parts where label = 'Small cap'").get() as { copy_states: string }
    expect(JSON.parse(small.copy_states)).toEqual(['printed'])
    expect(JSON.parse(cap().copy_states)).toEqual(['printed'])
  })
})

describe('one list: what the plates make is what the project makes (CG, 21 Oct)', () => {
  it('a part a plate makes is marked by its prints, not by hand, and cannot be removed out from under the plate', async () => {
    const { ctx, jobId } = await seedShop('inhouse')
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import sliced files/i), gcodeFile())
    await addAsEstimate(user)
    const list = await screen.findByRole('region', { name: /what this makes/i })
    const row = (await within(list).findByText('Cap')).closest('tr')!
    expect(within(row).queryByRole('button', { name: /^printed cap$/i })).toBeNull()
    expect(within(row).getByText(/from Reef buoy_sliced\.gcode/)).toBeDefined()
    await user.click(within(row).getByRole('button', { name: /^remove cap$/i }))
    expect(await screen.findByText(/Cap is made by Reef buoy_sliced\.gcode/)).toBeDefined()
    expect(screen.queryByRole('button', { name: /^remove it$/i })).toBeNull()
  })

  it('counts a plate object whose part was removed, from its prints, in one click', async () => {
    const { ctx, jobId, data } = await seedShop('inhouse')
    const d = data as any
    const imp = await d.importSlice(ctx.shop.id, jobId, ctx.profile.id, {
      fileName: 'Sliced_Maui_LAND_FLUSH_6h18m.bgcode', kind: 'gcode', printerModel: 'Prusa XL', printerId: ctx.printers[0].id,
      materialText: 'PETG', materialId: ctx.materials[0].id, estMinutes: 378, estGrams: 42, notes: [],
      sections: [{ label: 'Maui LAND FLUSH 3x', qty: 1, estMinutes: 378, estGrams: 42, material: 'PETG' }],
    })
    const run = await d.recordPrintRun(ctx.shop.id, jobId, ctx.profile.id, {
      printerId: ctx.printers[0].id, materialId: ctx.materials[0].id, unitsUsed: 42, hours: 6.3, outcome: 'success',
      failureReason: null, note: null, startedAt: '2026-09-14', sliceImportId: imp.importId,
    })
    await d.markPlatePrinted(ctx.shop.id, jobId, ctx.profile.id, imp.importId, run)
    // The old way: the part removed from the sheet, the plate left printing it.
    const part = currentDb.sqlite.prepare('select id from job_parts').get() as { id: string }
    await d.deletePart(ctx.shop.id, part.id, ctx.profile.id, null)
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    const note = await screen.findByRole('note', { name: /not counted/i })
    expect(note.textContent).toMatch(/Maui LAND FLUSH 3x — on Sliced_Maui_LAND_FLUSH_6h18m\.bgcode, printed 1 time/)
    await user.click(within(note).getByRole('button', { name: /^count it$/i }))
    await waitFor(() =>
      expect(currentDb.sqlite.prepare('select label, copy_states from job_parts').all()).toEqual([
        { label: 'Maui LAND FLUSH 3x', copy_states: '["printed"]' },
      ]),
    )
    await waitFor(() => expect(screen.queryByRole('note', { name: /not counted/i })).toBeNull())
  })
})
