/**
 * The hosted twins of the review fixes in reviewFixes.local.test.ts, run
 * against a small in-memory stand-in for the Supabase query builder.
 *
 * The stand-in is deliberately strict in one place, the way PostgREST is:
 * job_parts and slice_sections are linked twice (slice_sections.part_id and
 * job_parts.chosen_section_id), so an embed between them that does not name
 * its link is refused with PGRST201. Hosted markPlatePrinted used to embed
 * `job_parts!inner (...)` bare and failed on every call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const tables: Record<string, Row[]> = {}

interface Q {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert'
  sel: string
  payload: any
  single: boolean
  filters: [string, unknown][]
}

function run(q: Q): { data: any; error: any; count?: number } {
  const rows = (tables[q.table] ??= [])
  const match = (r: Row) => q.filters.every(([c, v]) => c.includes('.') || !(c in r) || r[c] === v)
  if (q.op === 'select') {
    if (q.table === 'slice_sections' && /\bjob_parts(!inner)?\s*\(/.test(q.sel)) {
      return {
        data: null,
        error: { code: 'PGRST201', message: "more than one relationship was found for 'slice_sections' and 'job_parts'" },
      }
    }
    const got = rows.filter(match)
    return q.single ? { data: got[0] ?? null, error: null } : { data: got, error: null }
  }
  if (q.op === 'update') {
    for (const r of rows.filter(match)) Object.assign(r, q.payload)
    return { data: null, error: null }
  }
  if (q.op === 'insert') {
    for (const p of Array.isArray(q.payload) ? q.payload : [q.payload]) rows.push({ ...p })
    return { data: null, error: null }
  }
  return { data: null, error: null }
}

function builder(table: string) {
  const q: Q = { table, op: 'select', sel: '*', payload: null, single: false, filters: [] }
  const b: any = {
    select(s = '*') {
      if (q.op === 'select') q.sel = s
      return b
    },
    insert(p: any) { q.op = 'insert'; q.payload = p; return b },
    update(p: any) { q.op = 'update'; q.payload = p; return b },
    upsert(p: any) { q.op = 'upsert'; q.payload = p; return b },
    delete() { q.op = 'delete'; return b },
    eq(c: string, v: unknown) { q.filters.push([c, v]); return b },
    in() { return b },
    or() { return b },
    not() { return b },
    lt() { return b },
    is() { return b },
    order() { return b },
    limit() { return b },
    like() { return b },
    gt() { return b },
    single() { q.single = true; return b },
    maybeSingle() { q.single = true; return b },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(run(q)).then(res, rej)
    },
  }
  return b
}

vi.mock('./supabase', () => ({ supabase: { from: (t: string) => builder(t) } }))

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
})

describe('hosted markPlatePrinted', () => {
  it('names the job_parts link and sums two sections on one part', async () => {
    const part = { id: 'p1', shop_id: 's', job_id: 'j', qty: 1, status: 'pending', printed_n: 0, passed_n: 0, reprint_n: 0, copy_states: null }
    tables.job_parts = [part]
    const embed = { qty: 1, printed_n: 0, passed_n: 0, reprint_n: 0, copy_states: null, shop_id: 's' }
    tables.slice_sections = [
      { import_id: 'imp', part_id: 'p1', qty: 1, slice_imports: { job_id: 'j' }, job_parts: embed },
      { import_id: 'imp', part_id: 'p1', qty: 1, slice_imports: { job_id: 'j' }, job_parts: embed },
    ]
    const S = await import('./data.supabase')
    await expect(S.markPlatePrinted('s', 'j', 'a', 'imp')).resolves.toBe(1)
    expect(tables.job_parts[0]).toMatchObject({ printed_n: 1, status: 'printed' })
    expect(tables.part_events).toHaveLength(1)
  })
})

describe('hosted replacement file for a failed copy', () => {
  it('links the file to the copy and recording it prints that copy', async () => {
    const part = { id: 'p1', shop_id: 's', job_id: 'j', qty: 3, status: 'reprint', printed_n: 0, passed_n: 0, reprint_n: 1, copy_states: '["pending","reprint","pending"]' }
    tables.job_parts = [part]
    const S = await import('./data.supabase')
    await S.requeueCopyFromFile('s', 'p1', 'a', 1, 'fix', 'hull v2.gcode')
    expect(JSON.parse(part.copy_states)).toEqual(['pending', 'pending', 'pending'])
    expect(tables.part_events.at(-1)).toMatchObject({ to_status: 'pending', copies: '2', slice_import_id: 'fix' })

    const embed = { ...part, shop_id: 's' }
    tables.slice_sections = [{ import_id: 'fix', part_id: 'p1', qty: 1, slice_imports: { job_id: 'j' }, job_parts: embed }]
    await S.markPlatePrinted('s', 'j', 'a', 'fix')
    expect(JSON.parse(part.copy_states)).toEqual(['pending', 'printed', 'pending'])
  })
})

describe('hosted setPartsCopies', () => {
  it('keeps a printed extra as a spare and renumbers the history', async () => {
    const part = { id: 'p1', shop_id: 's', job_id: 'j', label: 'Tagas', qty: 5, note: null, status: 'printed', printed_n: 4, passed_n: 0, reprint_n: 1, spare_n: 0, copy_states: '["printed","reprint","printed","printed","printed"]' }
    tables.job_parts = [part]
    tables.part_events = [{ id: 7, part_id: 'p1', copies: '2', to_status: 'reprint', note: 'Warped' }, { id: 8, part_id: 'p1', copies: '5', to_status: 'printed' }]
    const S = await import('./data.supabase')
    const out = await S.setPartsCopies('s', 'j', 'a', [{ partId: 'p1', qty: 3 }], 'Only three')
    // The failed copy goes first, then one printed copy becomes a spare.
    expect(out[0]).toMatchObject({ from: 5, to: 3, toSpare: 1, dropped: { pending: 0, reprint: 1 } })
    expect(part).toMatchObject({ qty: 3, spare_n: 1, printed_n: 3, reprint_n: 0 })
    expect(JSON.parse(part.copy_states)).toEqual(['printed', 'printed', 'printed'])
    expect(tables.part_events.find((e) => e.id === 7)?.copies).toBeNull()
    expect(tables.part_events.find((e) => e.id === 8)?.copies).toBeNull()
    expect(tables.job_events.at(-1)?.body).toMatch(/"Tagas" copies: 5 → 3 — 1 printed copy kept as a spare; 1 failed copy no longer reprinted\. Why: Only three/)
  })
})

describe('hosted plate and print links (CG, 13 Oct)', () => {
  it('a failed plate marks the copy failed, stamped with the print; removing it with undo puts it back', async () => {
    const part = { id: 'p1', shop_id: 's', job_id: 'j', qty: 2, status: 'pending', printed_n: 0, passed_n: 0, reprint_n: 0, copy_states: '["pending","pending"]' }
    tables.job_parts = [part]
    tables.print_runs = [{ id: 'run1', shop_id: 's', job_id: 'j', slice_import_id: 'imp' }]
    const embed = { ...part, shop_id: 's' }
    tables.slice_sections = [{ import_id: 'imp', part_id: 'p1', qty: 1, slice_imports: { job_id: 'j' }, job_parts: embed }]
    tables.part_events = []
    const S = await import('./data.supabase')
    await S.markPlateFailed('s', 'j', 'a', 'imp', 'run1', 'Spaghetti')
    expect(JSON.parse(part.copy_states)).toEqual(['reprint', 'pending'])
    const ev = tables.part_events.at(-1)!
    expect(ev).toMatchObject({ to_status: 'reprint', copies: '1', run_id: 'run1', note: 'Spaghetti' })
    ev.id = 1
    ev.kind = 'status'
    await expect(S.deletePrintRun('s', 'run1', true)).resolves.toBe(1)
    expect(JSON.parse(part.copy_states)).toEqual(['pending', 'pending'])
  })
})

describe('hosted correctPrintRun (CG, 14 Oct)', () => {
  it('updates the run, records what changed, and fails the copy it printed', async () => {
    const part = { id: 'p1', shop_id: 's', job_id: 'j', qty: 1, status: 'printed', printed_n: 1, passed_n: 0, reprint_n: 0, copy_states: '["printed"]' }
    tables.job_parts = [part]
    const run = { id: 'r1', shop_id: 's', job_id: 'j', units_used: 355, hours: 16.43, outcome: 'success', material_id: 'm', printer_id: 'pr', started_at: null, materials: { unit: 'g' } }
    tables.print_runs = [run]
    tables.part_events = [{ id: 1, part_id: 'p1', run_id: 'r1', kind: 'status', to_status: 'printed', copies: '1' }]
    const S = await import('./data.supabase')
    const n = await S.correctPrintRun('s', 'r1', 'a', { unitsUsed: 270, hours: 15, outcome: 'cancelled', failureReason: 'Ghost printing', note: null }, true)
    expect(n).toBe(1)
    expect(run).toMatchObject({ units_used: 270, hours: 15, outcome: 'cancelled', failure_reason: 'Ghost printing' })
    expect(JSON.parse(part.copy_states)).toEqual(['reprint'])
    expect(tables.job_events.at(-1)?.body).toMatch(/^Corrected a print — 355 g → 270 g · 16.43 h → 15 h · came off clean → stopped part way\./)
  })
})

describe('hosted facts read the quote that counts', () => {
  const quotes = [
    { id: 'q1', version: 1, status: 'accepted', total: 1000 },
    { id: 'q2', version: 2, status: 'draft', total: null },
  ]

  it('keeps the newest version as the printable, the accepted one for the facts', async () => {
    tables.jobs = [
      {
        id: 'j', shop_id: 's', ref: 'J-1', title: 'T', phase: 'building', kind: 'client', priority: 'normal',
        created_at: '2026-10-01', taken_in_at: '2026-10-01',
        clients: { id: 'c', name: 'Client', kind: null, contact: null },
        quotes,
        job_money: [{ deposit_due: 500, deposit_owed: 0, balance_owed: 1000 }],
        job_parts_summary: [], batches: [], job_actuals: [], job_events: [], job_gates: [],
      },
    ]
    const S = await import('./data.supabase')
    const [row] = await S.listJobs('s')
    expect(row.quoteId).toBe('q2')
    expect(row.facts.quoteStatus).toBe('accepted')
    expect(row.facts.quoteTotal).toBe(1000)
  })

  it('counts the accepted price in client value, not the draft', async () => {
    tables.clients = [
      { id: 'c', shop_id: 's', system: false, name: 'Client', jobs: [{ id: 'j', phase: 'building', quotes, job_money: [], job_events: [] }] },
    ]
    const S = await import('./data.supabase')
    const [c] = await S.listClients('s')
    expect(c.value).toBe(1000)
  })
})
