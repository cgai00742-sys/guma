/// <reference types="node" />
/**
 * The two backends must stay the same shape.
 *
 * data.ts picks between data.local.ts (SQLite, desktop) and
 * data.supabase.ts (Postgres, hosted) at runtime. Nothing type-checks the
 * pair against each other: the dispatcher calls `(await backend()).foo()`,
 * so a function added to one backend and forgotten in the other compiles
 * perfectly and throws "is not a function" the first time the OTHER build
 * runs it — which, on a project whose desktop app is the one being tested,
 * would be some stranger's first five minutes.
 *
 * Reading the source rather than importing it is deliberate: importing
 * data.supabase.ts evaluates supabase.ts, which throws when its env vars
 * are absent. This has to work in a bare checkout.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const LIB = dirname(fileURLToPath(import.meta.url))
const read = (f: string) => readFileSync(join(LIB, f), 'utf8')

/** Top-level `export function` / `export async function` names. */
function exportedFunctions(src: string): Set<string> {
  return new Set([...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]))
}

const shared = exportedFunctions(read('data.types.ts'))
const only = (s: Set<string>) => new Set([...s].filter((n) => !shared.has(n)))

const local = only(exportedFunctions(read('data.local.ts')))
const hosted = only(exportedFunctions(read('data.supabase.ts')))
const dispatcher = exportedFunctions(read('data.ts'))

const missing = (a: Set<string>, b: Set<string>) => [...a].filter((n) => !b.has(n)).sort()

describe('the two backends stay in step', () => {
  it('every local function exists on the hosted backend', () => {
    expect(
      missing(local, hosted),
      'added to data.local.ts and forgotten in data.supabase.ts — the web build would throw',
    ).toEqual([])
  })

  it('every hosted function exists on the local backend', () => {
    expect(
      missing(hosted, local),
      'added to data.supabase.ts and forgotten in data.local.ts — the desktop app would throw',
    ).toEqual([])
  })

  it('every backend function is reachable through the dispatcher', () => {
    expect(
      missing(local, dispatcher),
      'implemented in both backends but never exposed by data.ts, so no screen can call it',
    ).toEqual([])
  })

  it('the dispatcher never promises something a backend does not have', () => {
    const both = new Set([...local].filter((n) => hosted.has(n)))
    expect(missing(dispatcher, both)).toEqual([])
  })

  it('there is actually something to compare', () => {
    // Guards against the regexes silently matching nothing after a
    // refactor, which would make every assertion above pass vacuously.
    expect(local.size).toBeGreaterThan(20)
    expect(local.size).toBe(hosted.size)
  })
})

describe('the desktop build cannot reach Supabase by accident', () => {
  it('no screen imports the Supabase client or backend directly', () => {
    // The whole isTauri() split rests on data.supabase.ts being reached
    // ONLY through a dynamic import in data.ts. A static import anywhere
    // else pulls supabase.ts — which throws on missing env vars — into the
    // eagerly-evaluated bundle, and the desktop app dies on launch.
    const screens = join(LIB, '..', 'screens')
    const files = readFileSync(join(LIB, '..', 'App.tsx'), 'utf8')
    const offenders: string[] = []
    for (const [name, src] of [
      ['App.tsx', files],
      ...['Intake', 'Jobs', 'Pipeline', 'Projects', 'Project', 'Clients', 'Settings', 'Setup', 'QuoteDoc', 'Closeout'].map(
        (n) => [`${n}.tsx`, readFileSync(join(screens, `${n}.tsx`), 'utf8')] as const,
      ),
    ] as const) {
      if (/^import .*from '.*\/(supabase|data\.supabase)'/m.test(src)) offenders.push(name)
    }
    // SignIn is the one exception and is loaded with React.lazy from App.
    expect(offenders).toEqual([])
  })
})
