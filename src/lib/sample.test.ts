// @vitest-environment jsdom
/// <reference types="node" />
/**
 * The worked example, seeded against a real database.
 *
 * Two things worth proving. That it refuses to touch a real shop -- the
 * only rule here whose failure is unrecoverable, since sample records in a
 * shop's own books cannot be told apart from work afterwards. And that
 * what it produces is a project at each rung with real numbers behind it,
 * because a demo whose figures are empty demonstrates nothing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupPayload } from './data.types'

// The literal specifier would be bundled by vite for the jsdom
// environment and refused; joining it keeps it a runtime import. Same
// dodge as SliceImport.render.test.tsx.
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
const DIR = join(here, '../../src-tauri/migrations')
const SQL = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(DIR, f), 'utf8'))
  .join('\n')

function freshDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SQL)
  return {
    sqlite,
    path: 'sqlite:guma-demo.db',
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

const SETUP = {
  shop: {
    name: 'Demo Fab',
    currency: 'USD',
    locale: 'en-US',
    paper: 'letter',
    tax_label: 'GET',
    tax_pct: 4.712,
    state: 'HI',
    quote_valid_days: 30,
    lead_days: 10,
    electricity_rate_kwh: 0.43,
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
  printer: { name: 'Sakman', model: 'Prusa XL', tech: 'fdm', rate_hourly: 9, wear_hourly: 3, watts: 340 },
  materials: [{ name: 'PETG black', kind: 'PETG', swatch: '#2A3442', unit: 'g', cost_per_unit: 0.025 }],
  fullName: 'CG',
} as unknown as SetupPayload

function inDemo(on: boolean) {
  localStorage.setItem('guma.workspace', on ? 'demo' : 'shop')
}

beforeEach(() => {
  currentDb = freshDb()
  localStorage.clear()
  vi.resetModules()
})

describe('the worked example', () => {
  it('refuses to write into a real shop, which is the one mistake that cannot be undone', async () => {
    inDemo(false)
    const data = await import('./data')
    await data.setupShop(SETUP)
    const ctx = await data.loadShopContext()
    const { seedSample } = await import('./sample')
    await expect(seedSample(ctx)).rejects.toThrow(/demo/i)
    const jobs = currentDb.sqlite.prepare('select count(*) as n from jobs').get() as { n: number }
    expect(jobs.n).toBe(0)
  })

  it('leaves one project at each rung of the in-house ladder', async () => {
    inDemo(true)
    const data = await import('./data')
    await data.setupShop(SETUP)
    currentDb.sqlite.exec('update materials set on_hand = 2000')
    const ctx = await data.loadShopContext()
    const { seedSample } = await import('./sample')
    const res = await seedSample(ctx)
    expect(res.jobIds).toHaveLength(3)

    const phases = currentDb.sqlite
      .prepare("select phase from jobs where kind = 'inhouse' order by created_at, rowid")
      .all() as { phase: string }[]
    expect(phases.map((p) => p.phase)).toEqual(['design', 'review', 'delivered'])
  })

  it('puts real numbers behind them — a file, a failure, a shelf', async () => {
    inDemo(true)
    const data = await import('./data')
    await data.setupShop(SETUP)
    currentDb.sqlite.exec('update materials set on_hand = 2000')
    const ctx = await data.loadShopContext()
    const { seedSample } = await import('./sample')
    const { jobIds } = await seedSample(ctx)

    // Working: the file is in and nothing has been printed, so the stage
    // is honestly blocked -- which is what that stage looks like in use.
    const working = await data.loadProjectDetail(ctx.shop.id, jobIds[0])
    expect(working.slices).toHaveLength(1)
    expect(working.runs).toHaveLength(0)
    expect(working.facts.hasActuals).toBe(false)

    // Made: printed, one plate failed, one part sent back with a reason.
    const made = await data.loadProjectDetail(ctx.shop.id, jobIds[1])
    expect(made.runs).toHaveLength(2)
    expect(made.runs.some((r) => r.outcome === 'failed')).toBe(true)
    expect(made.parts.some((p) => p.status === 'reprint')).toBe(true)
    const reason = made.parts
      .find((p) => p.status === 'reprint')!
      .history.find((h) => h.toStatus === 'reprint')?.note
    expect(reason).toMatch(/Layer shift/)

    // Done: every part passed, units costed onto the shelf.
    const done = await data.loadProjectDetail(ctx.shop.id, jobIds[2])
    expect(done.parts.every((p) => p.status === 'passed')).toBe(true)
    expect(done.facts.unitsMade).toBe(40)
    expect(done.facts.hasActuals).toBe(true)
    expect(done.actuals.failedUnits).toBeGreaterThan(0)

    // And the shelf really moved: six runs of 159 g across three projects.
    const m = currentDb.sqlite.prepare('select on_hand from materials').get() as { on_hand: number }
    expect(Number(m.on_hand)).toBe(2000 - 159 * 4)
  })
})
