/**
 * Guards the one invariant the whole local-first pivot depends on: data.ts
 * must route to the SQLite backend inside Tauri and to the Supabase backend
 * everywhere else — and it must do it WITHOUT ever importing the other
 * backend, because data.supabase.ts's `import { supabase } from './supabase'`
 * throws at module-evaluation time if Supabase env vars are missing (see
 * supabase.ts), which is exactly the state a desktop build ships in once it
 * drops Supabase secrets (the p4-authdrop board task).
 *
 * This test would have caught the real bug found while wiring this up:
 * App.tsx statically imported SignIn.tsx, which statically imports
 * supabase.ts, which pulled supabase.ts into the same eagerly-evaluated
 * bundle as data.ts regardless of isTauri() — silently defeating the
 * dynamic-import isolation below. Fixed by lazy-loading SignIn instead.
 * That fix lives in App.tsx and isn't exercised by this file (which only
 * covers the data.ts dispatcher itself), so it's called out here as the
 * reason this test exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const localSpy = vi.fn(async () => 'local-shop-id')
const supabaseSpy = vi.fn(async () => 'supabase-shop-id')

vi.mock('./data.local', () => ({
  setupShop: localSpy,
  loadShopContext: vi.fn(),
  saveRateCard: vi.fn(),
  saveShopIdentity: vi.fn(),
  saveShopQuoteTerms: vi.fn(),
  savePrinter: vi.fn(),
  nextJobRef: vi.fn(),
  listJobs: vi.fn(),
  saveQuote: vi.fn(),
  loadQuoteForPrint: vi.fn(),
}))

vi.mock('./data.supabase', () => ({
  setupShop: supabaseSpy,
  loadShopContext: vi.fn(),
  saveRateCard: vi.fn(),
  saveShopIdentity: vi.fn(),
  saveShopQuoteTerms: vi.fn(),
  savePrinter: vi.fn(),
  nextJobRef: vi.fn(),
  listJobs: vi.fn(),
  saveQuote: vi.fn(),
  loadQuoteForPrint: vi.fn(),
}))

const payload = { shop: {}, rates: {}, printer: null, materials: [], fullName: 'Owner' }

afterEach(() => {
  vi.doUnmock('@tauri-apps/api/core')
  vi.resetModules()
  localSpy.mockClear()
  supabaseSpy.mockClear()
})

describe('data.ts dispatcher', () => {
  it('routes to the local (SQLite) backend inside Tauri, never touching the Supabase backend', async () => {
    vi.doMock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
    const data = await import('./data')
    await data.setupShop(payload)
    expect(localSpy).toHaveBeenCalledTimes(1)
    expect(supabaseSpy).not.toHaveBeenCalled()
  })

  it('routes to the Supabase backend outside Tauri, never touching the local backend', async () => {
    vi.doMock('@tauri-apps/api/core', () => ({ isTauri: () => false }))
    const data = await import('./data')
    await data.setupShop(payload)
    expect(supabaseSpy).toHaveBeenCalledTimes(1)
    expect(localSpy).not.toHaveBeenCalled()
  })
})
