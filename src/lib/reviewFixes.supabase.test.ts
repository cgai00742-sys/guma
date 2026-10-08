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
