/**
 * Guma ships to anyone who downloads it. These tests exist to stop a US
 * default creeping back in — every one of them is really the same assertion
 * written from a different angle: nothing regional is decided for the user,
 * and where Guma genuinely cannot know, it says so instead of guessing.
 */
import { describe, expect, it } from 'vitest'
import {
  currencyForRegion,
  currencyOptions,
  currencySymbol,
  osLocale,
  paperFor,
  paperForRegion,
  regionOf,
} from './locale'
import { formatDate } from './dates'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

describe('regionOf', () => {
  it('reads the region straight off a full tag', () => {
    expect(regionOf('en-GB')).toBe('GB')
    expect(regionOf('pt-BR')).toBe('BR')
    expect(regionOf('ja-JP')).toBe('JP')
  })

  it('maximises a bare language rather than giving up', () => {
    // 'de' with no region is still unambiguous enough to act on.
    expect(regionOf('de')).toBe('DE')
    expect(regionOf('ja')).toBe('JP')
  })

  it('returns empty for nothing, rather than a country', () => {
    expect(regionOf('')).toBe('')
    expect(regionOf(null)).toBe('')
    expect(regionOf(undefined)).toBe('')
    expect(regionOf('not a language tag at all')).toBe('')
  })
})

describe('currencyForRegion', () => {
  it('knows the ordinary cases', () => {
    expect(currencyForRegion('GB')).toBe('GBP')
    expect(currencyForRegion('DE')).toBe('EUR')
    expect(currencyForRegion('JP')).toBe('JPY')
    expect(currencyForRegion('IN')).toBe('INR')
    expect(currencyForRegion('NG')).toBe('NGN')
    expect(currencyForRegion('US')).toBe('USD')
  })

  it('is case-insensitive about the region', () => {
    expect(currencyForRegion('br')).toBe('BRL')
  })

  it('offers nothing at all for a region it does not know', () => {
    // The whole point: a wrong currency looks like a decision, a blank one
    // looks like a question. Never fall back to dollars.
    expect(currencyForRegion('ZZ')).toBe('')
    expect(currencyForRegion('')).toBe('')
  })
})

describe('paperForRegion', () => {
  it('gives Letter only where Letter is actually used', () => {
    expect(paperForRegion('US')).toBe('letter')
    expect(paperForRegion('CA')).toBe('letter')
    expect(paperForRegion('MX')).toBe('letter')
    expect(paperForRegion('PH')).toBe('letter')
  })

  it('gives A4 everywhere else, including regions it has never heard of', () => {
    expect(paperForRegion('GB')).toBe('a4')
    expect(paperForRegion('DE')).toBe('a4')
    expect(paperForRegion('JP')).toBe('a4')
    expect(paperForRegion('KE')).toBe('a4')
    expect(paperForRegion('ZZ')).toBe('a4')
    expect(paperForRegion('')).toBe('a4')
  })
})

describe('paperFor', () => {
  it('honours an explicit choice over the locale', () => {
    expect(paperFor({ paper: 'a4', locale: 'en-US' })).toBe('a4')
    expect(paperFor({ paper: 'letter', locale: 'de-DE' })).toBe('letter')
    expect(paperFor({ paper: 'LEGAL', locale: 'de-DE' })).toBe('legal')
  })

  it('derives from the shop locale when nothing has been chosen', () => {
    expect(paperFor({ paper: null, locale: 'en-US' })).toBe('letter')
    expect(paperFor({ paper: '', locale: 'fr-FR' })).toBe('a4')
  })

  it('ignores a stored value that is not a paper size', () => {
    expect(paperFor({ paper: 'foolscap', locale: 'en-US' })).toBe('letter')
  })
})

describe('currencyOptions', () => {
  const opts = currencyOptions('en')

  it('offers the whole world, not a shortlist', () => {
    // The old hand-kept list had ten entries and quietly said whose money
    // counted. This comes from the runtime's own CLDR data.
    expect(opts.length).toBeGreaterThan(100)
  })

  it('includes currencies a hand-written list would have forgotten', () => {
    const codes = new Set(opts.map((o) => o.code))
    for (const c of ['NGN', 'KES', 'IDR', 'VND', 'XOF', 'CLP', 'ISK', 'MAD']) {
      expect(codes.has(c)).toBe(true)
    }
  })

  it('names each one instead of showing a bare code', () => {
    const ngn = opts.find((o) => o.code === 'NGN')
    expect(ngn?.label.toLowerCase()).toContain('naira')
  })

  it('never returns a duplicate or an empty code', () => {
    const codes = opts.map((o) => o.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.every((c) => c.length === 3)).toBe(true)
  })
})

describe('currencySymbol', () => {
  it('gives the short symbol for unit labels', () => {
    expect(currencySymbol('USD', 'en-US')).toBe('$')
    expect(currencySymbol('EUR', 'de-DE')).toBe('€')
    expect(currencySymbol('GBP', 'en-GB')).toBe('£')
  })

  it('falls back to the code rather than to a dollar sign', () => {
    expect(currencySymbol('ZZZ', 'en-US')).toBe('ZZZ')
    expect(currencySymbol('')).toBe('')
  })
})

describe('osLocale', () => {
  it('never invents a locale when there is no browser to ask', () => {
    // Under node with no navigator, '' is the honest answer; every caller
    // treats '' as "let Intl use its own default".
    const tag = osLocale()
    expect(typeof tag).toBe('string')
    if (tag) expect(() => new Intl.Locale(tag)).not.toThrow()
  })
})

describe('document dates follow the shop, not the author', () => {
  it('writes the same day differently for different shops', () => {
    expect(formatDate('2026-09-03', 'en-US')).toBe('September 3, 2026')
    expect(formatDate('2026-09-03', 'en-GB')).toBe('3 September 2026')
    expect(formatDate('2026-09-03', 'de-DE')).toContain('September 2026')
  })

  it('reads a bare date as a local calendar day, not a UTC instant', () => {
    // The bug this guards: at UTC-10 a plain date parsed as UTC prints as
    // the day before.
    expect(formatDate('2026-01-01', 'en-GB')).toBe('1 January 2026')
  })

  it('falls back to the runtime locale rather than to en-US', () => {
    expect(formatDate('2026-09-03', '')).toMatch(/2026/)
  })

  it('hands back the input unchanged when it is not a date', () => {
    expect(formatDate('nonsense', 'en-GB')).toBe('nonsense')
  })
})

/**
 * The regression guard. Three separate bugs in this codebase have been a
 * hard-coded 'en-US' or 'USD' sitting quietly in a fallback, so this walks
 * the source and fails if one comes back anywhere it doesn't belong.
 */
describe('no region is hard-coded into the app', () => {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) out.push(...walk(full))
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.')) out.push(full)
    }
    return out
  }

  // Where a literal is legitimate, with the reason it is:
  //  - locale.ts        the region -> currency table itself, plus 'en' as a
  //                     last-resort DISPLAY language for currency names
  //  - taxHelp.ts       US state tax names; the whole file is US-only by
  //                     definition and only renders for US shops
  //  - data.supabase.ts the hosted Postgres columns are NOT NULL, and the
  //                     browser build is not the supported 1.0 path
  const ALLOWED = new Set(['src/lib/locale.ts', 'src/lib/taxHelp.ts', 'src/lib/data.supabase.ts'])

  /** Code only. A comment that mentions 'en-US' as an example of a language
   *  tag is documentation; a fallback that uses one is the bug. */
  const codeOf = (file: string) =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

  const files = walk('src')

  it('has files to check at all', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  it("never falls back to 'en-US'", () => {
    const guilty = files.filter(
      (f) => !ALLOWED.has(f.replace(/\\/g, '/')) && codeOf(f).includes('en-US'),
    )
    expect(guilty).toEqual([])
  })

  it("never falls back to 'USD'", () => {
    const guilty = files.filter(
      (f) => !ALLOWED.has(f.replace(/\\/g, '/')) && /'USD'|"USD"/.test(codeOf(f)),
    )
    expect(guilty).toEqual([])
  })

  it('never asks for or stores a timezone', () => {
    // dates.ts derives everything from the OS clock's local fields. A
    // timezone column or picker would be a second source of truth that can
    // disagree with the clock on screen.
    const guilty = files.filter((f) => {
      const src = codeOf(f)
      return /\btimeZone\s*:/.test(src) || /\btime_zone\b/.test(src)
    })
    expect(guilty).toEqual([])
  })

  it('lays documents out on a derived page size, never a fixed one', () => {
    for (const f of ['src/screens/QuoteDoc.tsx', 'src/screens/Closeout.tsx']) {
      const src = readFileSync(f, 'utf8')
      expect(src).toContain('paperFor(')
      expect(src).not.toMatch(/size="letter"/)
    }
  })
})
