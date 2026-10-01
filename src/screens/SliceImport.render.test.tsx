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
  await screen.findByLabelText(/import a sliced file/i)
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

    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())

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
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())

    // "XL" in the file, "Prusa XL" in the shop -- and the label says which
    // word came from the file, so a wrong match is visible rather than
    // silent. That is the Voltage "Pursa XL" lesson.
    const printer = (await screen.findByLabelText(/machine/i)) as HTMLSelectElement
    expect(printer.selectedOptions[0].textContent).toMatch(/Sakman/)
    const material = screen.getByLabelText(/material/i) as HTMLSelectElement
    expect(material.selectedOptions[0].textContent).toMatch(/PETG black/)
  })

  it('writes the build sheet when confirmed, and nothing before', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
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
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
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
      screen.getByLabelText(/import a sliced file/i),
      new File(['\x00\x01binary'], 'part.bgcode', { type: 'application/octet-stream' }),
    )

    // The message names the exact PrusaSlicer setting to change, because
    // "unsupported file" would send someone hunting.
    await screen.findByText(/binary G-code/i)
    expect(currentDb.sqlite.prepare('select count(*) as n from slice_imports').get()).toEqual({
      n: 0,
    })
  })

  it('discards a file without writing it', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
    await screen.findByText('Reef buoy_sliced.gcode')

    await user.click(screen.getByRole('button', { name: /discard/i }))

    await waitFor(() => expect(screen.queryByText('Reef buoy_sliced.gcode')).toBeNull())
    expect(currentDb.sqlite.prepare('select count(*) as n from job_parts').get()).toEqual({ n: 0 })
  })

  it('re-importing a fixed file does not duplicate the parts', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
    await addAsEstimate(user)
    await screen.findByText('Buoy shell')

    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile('fixed_v2.gcode'))
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
      screen.getByLabelText(/import a sliced file/i),
      new File([other], 'k1.gcode', { type: 'text/plain' }),
    )

    const printer = (await screen.findByLabelText(/machine/i)) as HTMLSelectElement
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

    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
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
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
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
    for (const to of ['design', 'approval', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())

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
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
    await addAsEstimate(user)

    await user.click(await screen.findByRole('button', { name: /this print happened/i }))

    // Pre-filled from the file: 86.5 g rounds to 87, 2h 3m to 2.05 hours.
    const units = (await screen.findByLabelText(/off the spool/i)) as HTMLInputElement
    expect(units.value).toBe('87')
    const hours = screen.getByLabelText(/machine hours/i) as HTMLInputElement
    expect(hours.value).toBe('2.05')

    await user.click(screen.getByRole('button', { name: /^record it$/i }))

    await waitFor(() => {
      const a = currentDb.sqlite
        .prepare('select material_units, machine_hours, runs from job_actuals where job_id = ?')
        .get(jobId) as Record<string, number>
      expect(a).toMatchObject({ material_units: 87, machine_hours: 2.05, runs: 1 })
    })
    const m = currentDb.sqlite.prepare('select on_hand from materials').get() as { on_hand: number }
    expect(Number(m.on_hand)).toBe(913)
    await screen.findByText(/Recorded — 1 run/i)
  })

  it('asks what went wrong when the print failed, and still bills the material', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
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
    await screen.findByRole('button', { name: /record another run/i })
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
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
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

    await screen.findByText(/The file is kept with this project/)
    expect(screen.getByRole('button', { name: /save a copy/i })).toBeDefined()
  })

  it('removes an import without erasing the print that was recorded from it', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    for (const to of ['design', 'approval', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
    await addAsEstimate(user)
    await user.click(await screen.findByRole('button', { name: /this print happened/i }))
    await user.click(screen.getByRole('button', { name: /^record it$/i }))
    await screen.findByText(/Recorded — 1 run/i)

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
    for (const to of ['design', 'approval', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
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

  it('leaves the parts alone when the plate failed', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    for (const to of ['design', 'approval', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
    await addAsEstimate(user)
    await user.click(await screen.findByRole('button', { name: /this print happened/i }))
    await user.selectOptions(await screen.findByLabelText(/how it went/i), 'failed')
    // The offer goes away: a failed plate produced nothing to check.
    expect(screen.queryByLabelText(/mark the 2 parts on this plate/i)).toBeNull()
    await user.type(await screen.findByLabelText(/what went wrong/i), 'Clog')
    await user.click(screen.getByRole('button', { name: /^record it$/i }))

    await waitFor(() => {
      const n = currentDb.sqlite
        .prepare("select count(*) as n from job_parts where status = 'pending'")
        .get() as { n: number }
      expect(n.n).toBe(2)
    })
  })
})

describe('a finished project reads like a record, not a control panel', () => {
  /** CG, on his one finished project: "I don't see a bunch of useful
   *  information there. I don't see the printed file either." */
  it('summarises what it came to, and names the file it was printed from', async () => {
    const { ctx, jobId, data } = await seedShop()
    const user = userEvent.setup()
    currentDb.sqlite.exec('update materials set on_hand = 1000')
    for (const to of ['design', 'approval', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
    await addAsEstimate(user)
    await user.click(await screen.findByRole('button', { name: /this print happened/i }))
    await user.click(screen.getByRole('button', { name: /^record it$/i }))
    await screen.findByText(/Recorded — 1 run/i)

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
    expect(screen.getByText(/87 g · 2\.1 h/)).toBeDefined()
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

    const drop = screen.getByLabelText(/import a sliced file/i)
    const manual = screen.getByLabelText(/^part$/i)
    // Node.compareDocumentPosition: 4 means `manual` follows `drop`.
    expect(drop.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('offers a drop target, not just a file button', async () => {
    const { ctx, jobId } = await seedShop()
    await renderProject(jobId, ctx)
    expect(screen.getByText(/drop a sliced file here/i)).toBeDefined()
  })

  it('says what it did after importing, in a sentence', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
    await addAsEstimate(user)

    // The thing whose absence read as "nothing happened". It also says
    // the file itself was kept, which is the other half of the answer.
    await screen.findByText(/Reef buoy_sliced\.gcode — 2 parts added, file kept\./i)
  })

  it('says when a re-import updated parts rather than adding them', async () => {
    const { ctx, jobId } = await seedShop()
    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
    await addAsEstimate(user)
    await screen.findByText('Buoy shell')

    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile('fixed_v2.gcode'))
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
    for (const to of ['design', 'approval', 'scheduled', 'building'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }
    await renderProject(jobId, ctx)
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile())
    await user.click(await screen.findByRole('button', { name: /record the print/i }))
    await screen.findByText(/Recorded as printed on/i)

    const row = (await screen.findByText('Buoy shell')).closest('tr')!
    await user.click(within(row).getByRole('button', { name: /send back/i }))
    const send = screen.getByRole('button', { name: /send it back/i })
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
    const note = await screen.findByRole('note', { name: /failures on this project/i })
    expect(note.textContent).toMatch(/1 send-back across 1 part/)
  })
})

describe("CG's Maui: one G-code uploaded several times, project already Done", () => {
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
    for (const to of ['review', 'delivered'] as const) {
      await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
    }

    const user = userEvent.setup()
    await renderProject(jobId, ctx)

    const region = await screen.findByRole('region', { name: /from the sliced files/i })
    // Open on a finished project, not folded away.
    expect(region.closest('details')?.hasAttribute('open')).toBe(true)
    expect(within(region).getAllByText('Maui bathy.gcode')).toHaveLength(1)
    within(region).getByText(/uploaded 3 times — counted once/i)
    within(region).getByText(/87 g · 2\.05 h/)

    // One machine in the shop, so nothing to pick.
    await user.click(within(region).getByRole('button', { name: /record maui bathy\.gcode from the file/i }))
    await waitFor(() => {
      const a = currentDb.sqlite
        .prepare('select material_units, machine_hours, runs from job_actuals where job_id = ?')
        .get(jobId) as Record<string, number>
      expect(a).toMatchObject({ material_units: 87, machine_hours: 2.05, runs: 1 })
    })
    await within(region).findByText(/✓ 87 g · 2\.05 h/)

    // Uploading it yet again, at Done, adds nothing and counts nothing twice.
    await user.upload(screen.getByLabelText(/import a sliced file/i), gcodeFile('Maui bathy.gcode'))
    await user.click(await screen.findByRole('button', { name: /record the print/i }))
    await screen.findByText(/not added again/i)
    expect(currentDb.sqlite.prepare('select count(*) as n from slice_imports').get()).toEqual({ n: 3 })
    expect(currentDb.sqlite.prepare('select count(*) as n from print_runs').get()).toEqual({ n: 1 })
  })
})
