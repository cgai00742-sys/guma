/// <reference types="node" />
/**
 * Money facts against a real SQLite database: what is paid, owed and
 * overpaid once work is under way (CG's 16" Anson, 27 Oct 2026).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    sqlite,
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
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => currentDb } }))
// The quote-build tests below go through the DISPATCHER (./data) rather than
// data.local directly, because saveQuote is what a screen calls. Without
// this the dispatcher decides it is not in Tauri, loads data.supabase and
// tries to reach the network -- which fails as "fetch failed", naming
// nothing useful.
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

const SHOP = 'shop-1'
const JOB = 'job-1'
const ACTOR = 'actor-1'

/** A delivered client project like CG's 16" Anson: one quote, sent. */
function seed(db: ReturnType<typeof freshDb>) {
  db.sqlite.exec(`
    insert into shops (id, name, slug, currency, locale)
      values ('${SHOP}', 'Test', 'test', 'USD', 'en-US');
    insert into profiles (id, shop_id, full_name, role)
      values ('${ACTOR}', '${SHOP}', 'CG', 'owner');
    insert into clients (id, shop_id, name) values ('client-1', '${SHOP}', 'Anson');
    insert into jobs (id, shop_id, ref, client_id, title, phase)
      values ('${JOB}', '${SHOP}', 'J-001', 'client-1', '16in Anson', 'delivered');
    insert into quotes (id, shop_id, job_id, version, status, total, deposit_due, sent_at)
      values ('q1', '${SHOP}', '${JOB}', 1, 'sent', 160.68, 80.34, '2026-10-10T00:00:00Z');
  `)
}

beforeEach(() => {
  currentDb = freshDb()
  seed(currentDb)
  vi.resetModules()
})

async function facts() {
  const { loadProjectDetail } = await import('./data.local')
  return (await loadProjectDetail(SHOP, JOB)).facts
}

async function pay(kind: 'deposit' | 'balance' | 'partial' | 'refund', amount: number) {
  const { recordPayment } = await import('./data.local')
  await recordPayment(SHOP, JOB, ACTOR, {
    kind, amount, method: 'cash', receivedOn: '2026-10-19', note: null, quoteId: null,
  })
}

describe('money once work is under way', () => {
  it('a sent quote nobody accepted still prices what is owed', async () => {
    const f = await facts()
    expect(f.quoteStatus).toBe('sent')
    expect(f.balanceOwed).toBeCloseTo(160.68)
    expect(f.paid).toBe(0)
  })

  it('one payment recorded as Balance clears the deposit too', async () => {
    await pay('balance', 160.68)
    const f = await facts()
    expect(f.depositOwed).toBe(0)
    expect(f.balanceOwed).toBe(0)
    expect(f.paid).toBeCloseTo(160.68)
  })

  it('paying more than the price shows as overpaid, not vanished', async () => {
    await pay('balance', 300)
    const f = await facts()
    expect(f.balanceOwed).toBe(0)
    expect(f.overpaid).toBeCloseTo(139.32)
  })

  it('a refund after paying in full is owed back on the balance, not the deposit', async () => {
    await pay('balance', 160.68)
    await pay('refund', 10)
    const f = await facts()
    expect(f.depositOwed).toBe(0)
    expect(f.balanceOwed).toBeCloseTo(10)
    expect(f.paid).toBeCloseTo(150.68)
  })

  it('Anson: revise to the agreed $300, mark it agreed, record $300 -- square', async () => {
    currentDb.sqlite.exec(`
      insert into quotes (id, shop_id, job_id, version, status, total, deposit_due, sent_at)
        values ('q2', '${SHOP}', '${JOB}', 2, 'sent', 300, 150, '2026-10-19T00:00:00Z');
    `)
    const { setQuoteStatus } = await import('./data.local')
    await setQuoteStatus(SHOP, 'q2', ACTOR, 'accepted')
    await pay('balance', 300)
    const f = await facts()
    expect(f.quoteStatus).toBe('accepted')
    expect(f.quoteTotal).toBe(300)
    expect(f.paid).toBe(300)
    expect(f.balanceOwed).toBe(0)
    expect(f.overpaid).toBe(0)
    expect(f.depositOwed).toBe(0)
  })

})
