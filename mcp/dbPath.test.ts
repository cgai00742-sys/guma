/**
 * Where the MCP server looks for the database.
 *
 * The failure mode this guards against is the quiet one: point SQLite at a
 * path that does not exist and it cheerfully creates an empty file, so the
 * assistant reports a shop with no rates and no projects. That looks like a
 * bug in Guma, and the person will go looking in the wrong place. So the
 * resolver either finds a real file or says exactly where it looked.
 */
import { describe, expect, it } from 'vitest'
import {
  APP_IDENTIFIER,
  DatabaseNotFound,
  candidates,
  dbFlagFrom,
  resolveDbPath,
  type PathEnv,
} from './dbPath'

const mac: PathEnv = { platform: 'darwin', home: '/Users/anke', env: {} }
const linux: PathEnv = { platform: 'linux', home: '/home/anke', env: {} }
const win: PathEnv = { platform: 'win32', home: 'C:\\Users\\anke', env: { APPDATA: 'C:\\Users\\anke\\AppData\\Roaming' } }

describe('the identifier is the one the app actually ships', () => {
  it('matches src-tauri/tauri.conf.json', async () => {
    // If someone renames the bundle, the MCP server silently stops finding
    // the database. This is the tripwire.
    const conf = JSON.parse(
      await import('node:fs').then((fs) => fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')),
    )
    expect(APP_IDENTIFIER).toBe(conf.identifier)
  })
})

describe('candidates', () => {
  it('looks in Tauri’s app config dir first on macOS', () => {
    expect(candidates(mac)[0]).toBe(
      '/Users/anke/Library/Application Support/house.guma.app/guma.db',
    )
  })

  it('honours XDG_CONFIG_HOME on Linux, and falls back to ~/.config', () => {
    expect(candidates(linux)[0]).toBe('/home/anke/.config/house.guma.app/guma.db')
    expect(candidates({ ...linux, env: { XDG_CONFIG_HOME: '/home/anke/cfg' } })[0]).toBe(
      '/home/anke/cfg/house.guma.app/guma.db',
    )
  })

  it('uses APPDATA on Windows', () => {
    // Separators are normalised before comparing: node:path.join uses the
    // separator of the machine RUNNING the test, not of the platform being
    // described, and the release matrix runs this suite on three of them.
    // Same shape as the timezone bug — an assertion that quietly depends on
    // where it happens to be standing.
    const sep = (p: string) => p.replace(/\\/g, '/')
    expect(sep(candidates(win)[0]!)).toContain('AppData/Roaming/house.guma.app/guma.db')
  })

  it('offers more than one place to look on every platform', () => {
    for (const e of [mac, linux, win]) expect(candidates(e).length).toBeGreaterThan(1)
  })
})

describe('resolveDbPath', () => {
  it('takes --db without checking it, because the person said where it is', () => {
    // A "no such file" from SQLite naming their own path is a better error
    // than this function deciding they meant somewhere else.
    const p = resolveDbPath({ flag: '/tmp/mine.db', env: mac, exists: () => false })
    expect(p).toBe('/tmp/mine.db')
  })

  it('accepts GUMA_DB the same way', () => {
    const p = resolveDbPath({ env: { ...mac, env: { GUMA_DB: '/tmp/env.db' } }, exists: () => false })
    expect(p).toBe('/tmp/env.db')
  })

  it('prefers an explicit flag over the environment', () => {
    const p = resolveDbPath({
      flag: '/tmp/flag.db',
      env: { ...mac, env: { GUMA_DB: '/tmp/env.db' } },
      exists: () => false,
    })
    expect(p).toBe('/tmp/flag.db')
  })

  it('finds the app’s own database when nothing is specified', () => {
    const real = candidates(mac)[0]!
    expect(resolveDbPath({ env: mac, exists: (p) => p === real })).toBe(real)
  })

  it('names every place it looked rather than inventing a file', () => {
    try {
      resolveDbPath({ env: mac, exists: () => false })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseNotFound)
      const msg = (e as Error).message
      expect(msg).toContain('Library/Application Support/house.guma.app/guma.db')
      expect(msg).toContain('--db')
      expect(msg).toContain('Open Guma once')
    }
  })

  it('treats a blank override as no override', () => {
    const real = candidates(linux)[0]!
    expect(resolveDbPath({ flag: '   ', env: linux, exists: (p) => p === real })).toBe(real)
  })
})

describe('dbFlagFrom', () => {
  it('reads both spellings', () => {
    expect(dbFlagFrom(['--db', '/tmp/a.db'])).toBe('/tmp/a.db')
    expect(dbFlagFrom(['--db=/tmp/b.db'])).toBe('/tmp/b.db')
    expect(dbFlagFrom(['--read-only'])).toBeNull()
    expect(dbFlagFrom([])).toBeNull()
  })

  it('is not confused by --db as the last argument', () => {
    expect(dbFlagFrom(['--read-only', '--db'])).toBeNull()
  })
})
