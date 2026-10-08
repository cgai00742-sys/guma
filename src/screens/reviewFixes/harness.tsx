/**
 * Shared harness for the screen-review repros. Same shape as
 * src/screens/Project.render.test.tsx: real node:sqlite, every migration.
 * Each repro file must itself vi.mock '@tauri-apps/plugin-sql' to return
 * `holder.db`, and '@tauri-apps/api/core' with isTauri -> true.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

const { DatabaseSync } = (await import(/* @vite-ignore */ ['node', 'sqlite'].join(':'))) as {
  DatabaseSync: new (path: string) => any
}

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION_SQL = readdirSync(join(here, '../../../src-tauri/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '../../../src-tauri/migrations', f), 'utf8'))
  .join('\n')

export function freshDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MIGRATION_SQL)
  return {
    path: 'sqlite:guma.db',
    sqlite,
    async execute(sql: string, params: unknown[] = []) {
      const info = sqlite.prepare(sql).run(...(params as never[]))
      return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) }
    },
    async select(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...(params as never[]))
    },
  }
}

export const holder: { db: ReturnType<typeof freshDb> | null } = ((globalThis as any).__reviewHolder ??= {
  db: null,
})

export const SHOP = {
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
export const RATES = {
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

export async function seed({ takeIn = true }: { takeIn?: boolean } = {}) {
  holder.db = freshDb()
  vi.resetModules()
  const data = await import('../../lib/data')
  const shopId = await data.setupShop({
    shop: SHOP,
    rates: RATES,
    printer: { name: 'Prusa XL', model: 'XL 5T', tech: 'fdm', rate_hourly: 9, wear_hourly: 3, watts: 350 },
    materials: [{ name: 'PLA', kind: 'PLA', swatch: '#5A6B7C', unit: 'g', cost_per_unit: 0.095 }],
    fullName: 'Anke Roth',
  } as any)
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
  } as any)
  if (takeIn) await data.takeProjectIn(shopId, saved.jobId, ctx.profile.id)
  return { ctx, jobId: saved.jobId, ref, data, shopId }
}

export async function moveTo(data: any, ctx: any, jobId: string, phase: string) {
  const ladder = ['approval', 'design', 'scheduled', 'building', 'review', 'delivered']
  for (const to of ladder.slice(0, ladder.indexOf(phase) + 1)) {
    await data.updateJobPhase(ctx.shop.id, jobId, ctx.profile.id, to)
  }
}
