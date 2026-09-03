/**
 * Finding the database the desktop app is actually using.
 *
 * The MCP server is a second process reading the same SQLite file the Guma
 * window has open, so it has to land on exactly the right path or it will
 * silently create an empty database next door and report a shop with no
 * projects — which looks like a bug in Guma rather than a wrong path.
 *
 * `tauri-plugin-sql` resolves `sqlite:guma.db` against Tauri's app CONFIG
 * directory, keyed on the bundle identifier in src-tauri/tauri.conf.json
 * (`house.guma.app`). That gives:
 *
 *   macOS    ~/Library/Application Support/house.guma.app/guma.db
 *   Linux    $XDG_CONFIG_HOME/house.guma.app/guma.db, else ~/.config/...
 *   Windows  %APPDATA%\house.guma.app\guma.db
 *
 * Every one of those is a guess about someone else's machine, so both
 * overrides come first and the resolver reports what it tried when it finds
 * nothing. A wrong answer here must never be silent.
 */
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/** Must match `identifier` in src-tauri/tauri.conf.json. */
export const APP_IDENTIFIER = 'house.guma.app'
export const DB_FILE = 'guma.db'

export interface PathEnv {
  platform: string
  home: string
  env: Record<string, string | undefined>
}

export function defaultEnv(): PathEnv {
  return { platform: platform(), home: homedir(), env: process.env }
}

/** Every place the app's database could reasonably be, most likely first. */
export function candidates(e: PathEnv = defaultEnv()): string[] {
  const out: string[] = []
  if (e.platform === 'darwin') {
    out.push(join(e.home, 'Library', 'Application Support', APP_IDENTIFIER, DB_FILE))
    // Older Tauri builds resolved to the data dir; harmless to look.
    out.push(join(e.home, 'Library', 'Application Support', 'Guma', DB_FILE))
  } else if (e.platform === 'win32') {
    const appData = e.env.APPDATA ?? join(e.home, 'AppData', 'Roaming')
    out.push(join(appData, APP_IDENTIFIER, DB_FILE))
    out.push(join(appData, APP_IDENTIFIER, 'config', DB_FILE))
  } else {
    const xdg = e.env.XDG_CONFIG_HOME ?? join(e.home, '.config')
    out.push(join(xdg, APP_IDENTIFIER, DB_FILE))
    const xdgData = e.env.XDG_DATA_HOME ?? join(e.home, '.local', 'share')
    out.push(join(xdgData, APP_IDENTIFIER, DB_FILE))
  }
  return out
}

export interface ResolveOptions {
  /** From `--db`. Wins over everything, and is never second-guessed. */
  flag?: string | null
  env?: PathEnv
  exists?: (p: string) => boolean
}

export class DatabaseNotFound extends Error {
  constructor(public readonly tried: string[]) {
    super(
      'Could not find Guma’s database. Tried:\n  ' +
        tried.join('\n  ') +
        '\n\nOpen Guma once so it creates one, or point at it with --db <path> ' +
        'or the GUMA_DB environment variable.',
    )
    this.name = 'DatabaseNotFound'
  }
}

/**
 * The database path, or a DatabaseNotFound naming everywhere it looked.
 *
 * An explicit --db or GUMA_DB is returned WITHOUT checking it exists: the
 * person said where it is, and a "no such file" from SQLite naming their own
 * path is a better error than this function guessing they meant somewhere
 * else.
 */
export function resolveDbPath(opts: ResolveOptions = {}): string {
  const e = opts.env ?? defaultEnv()
  const exists = opts.exists ?? existsSync
  const explicit = opts.flag ?? e.env.GUMA_DB
  if (explicit && explicit.trim()) return explicit.trim()

  const tried = candidates(e)
  const hit = tried.find(exists)
  if (!hit) throw new DatabaseNotFound(tried)
  return hit
}

/** Pulls `--db <path>` (or `--db=<path>`) out of an argv tail. */
export function dbFlagFrom(argv: string[]): string | null {
  const i = argv.indexOf('--db')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]!
  const inline = argv.find((a) => a.startsWith('--db='))
  return inline ? inline.slice('--db='.length) : null
}
