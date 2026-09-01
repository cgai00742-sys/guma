/**
 * The runtime dispatcher. Every screen imports from here — never from
 * data.supabase.ts or data.local.ts directly — so switching backends never
 * touches a screen's import statements or call sites.
 *
 * Which backend is active is decided once, lazily, the first time any
 * function below is actually called: isTauri() is true only inside the
 * desktop app, in which case we dynamically import data.local.ts (SQLite,
 * no auth); everywhere else (the Cloudflare Pages web build) we dynamically
 * import data.supabase.ts (hosted, auth-gated).
 *
 * The dynamic import matters, not just the isTauri() check: a plain static
 * `import` of data.supabase.ts at the top of this file would evaluate its
 * `import { supabase } from './supabase'` immediately, on every load of
 * data.ts — including inside the desktop app — and supabase.ts throws at
 * module-load time if its env vars are missing (see supabase.ts). Once the
 * desktop build stops carrying Supabase secrets (the p4-authdrop board
 * task), a static import here would crash the app on startup. The dynamic
 * import defers evaluation until we already know, via isTauri(), that we
 * are not going to touch that module at all.
 *
 * Types and other side-effect-free logic (toRateSet, NeedsSetup, and every
 * shared interface) are re-exported directly from data.types.ts rather than
 * routed through either backend, since both backends already do the same.
 */
import { isTauri } from '@tauri-apps/api/core'
import type * as Local from './data.local'
import type * as Hosted from './data.supabase'
import type {
  Shop,
  RateCardRow,
  PrinterRow,
  Profile,
  ShopContext,
  SetupPayload,
  ShopIdentityInput,
  ShopQuoteTermsInput,
  SaveQuoteArgs,
  SavedQuote,
} from './data.types'

export { NeedsSetup, toRateSet } from './data.types'
export type {
  Shop,
  RateCardRow,
  PrinterRow,
  Profile,
  ShopContext,
  SetupPayload,
  ShopIdentityInput,
  ShopQuoteTermsInput,
  SaveQuoteArgs,
  SavedQuote,
}

type Backend = typeof Local | typeof Hosted

let backendPromise: Promise<Backend> | null = null
function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = isTauri() ? import('./data.local') : import('./data.supabase')
  }
  return backendPromise
}

export async function setupShop(p: SetupPayload): Promise<string> {
  return (await backend()).setupShop(p)
}

export async function loadShopContext(): Promise<ShopContext> {
  return (await backend()).loadShopContext()
}

export async function saveRateCard(
  shopId: string,
  next: Omit<RateCardRow, 'id' | 'shop_id' | 'effective_from'>,
): Promise<RateCardRow> {
  return (await backend()).saveRateCard(shopId, next)
}

export async function saveShopIdentity(shopId: string, next: ShopIdentityInput): Promise<Shop> {
  return (await backend()).saveShopIdentity(shopId, next)
}

export async function saveShopQuoteTerms(shopId: string, next: ShopQuoteTermsInput): Promise<Shop> {
  return (await backend()).saveShopQuoteTerms(shopId, next)
}

export async function savePrinter(
  shopId: string,
  next: Omit<PrinterRow, 'id'> & { id?: string },
): Promise<PrinterRow> {
  return (await backend()).savePrinter(shopId, next)
}

export async function nextJobRef(shopId: string): Promise<string> {
  return (await backend()).nextJobRef(shopId)
}

export async function saveQuote(args: SaveQuoteArgs): Promise<SavedQuote> {
  return (await backend()).saveQuote(args)
}

export async function loadQuoteForPrint(quoteId: string) {
  return (await backend()).loadQuoteForPrint(quoteId)
}
