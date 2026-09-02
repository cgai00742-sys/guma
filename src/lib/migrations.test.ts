/// <reference types="node" />
/**
 * A migration that has shipped is frozen.
 *
 * This test exists because ignoring that rule cost a real afternoon. 0005
 * was written, applied to a running database, and then edited in place to
 * fix a SQLite integer-division bug. sqlx stores a SHA-384 of every
 * migration when it applies it, so the next launch refused to open the
 * database at all:
 *
 *   "migration 5 was previously applied but has been modified"
 *
 * Which is sqlx being right. A migration is a claim about what a database
 * has already had done to it; editing one makes that claim a lie, and no
 * amount of care at the keyboard catches it, because the file still looks
 * correct — it is only wrong relative to a database somewhere else.
 *
 * So the checksums are committed alongside the files. Editing a shipped
 * migration now fails here, in a second, instead of on somebody's machine
 * a week later. A NEW migration is expected and welcome: add the file, run
 * `npm run migrations:lock`, and the lock file records it.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src-tauri/migrations')
const locked: Record<string, string> = JSON.parse(
  readFileSync(join(DIR, 'checksums.json'), 'utf8'),
)
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()

describe('shipped migrations are frozen', () => {
  it('every migration file matches its recorded checksum', () => {
    for (const name of files) {
      const actual = createHash('sha384').update(readFileSync(join(DIR, name))).digest('hex')
      expect(
        locked[name],
        `${name} is not in checksums.json — run: npm run migrations:lock`,
      ).toBeDefined()
      expect(
        actual,
        `${name} has been EDITED after shipping. sqlx will refuse to open any database that ` +
          `already applied the old version. Put the change in a NEW migration instead; only ` +
          `re-lock if this file has never left your machine.`,
      ).toBe(locked[name])
    }
  })

  it('no recorded migration has been deleted or renamed', () => {
    for (const name of Object.keys(locked)) {
      expect(files, `${name} is in checksums.json but missing from disk`).toContain(name)
    }
  })

  it('versions are unique and start at 1 with no gaps', () => {
    // A gap or a duplicate means the runner in src-tauri/src/lib.rs and the
    // files on disk have drifted apart, which fails at launch rather than
    // at build time.
    const versions = files.map((f) => Number(f.split('_')[0]))
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1))
  })

  it('every migration on disk is registered with the Tauri runner', () => {
    const lib = readFileSync(join(DIR, '../src/lib.rs'), 'utf8')
    for (const name of files) {
      expect(lib, `${name} exists but lib.rs never includes it — it will never run`).toContain(name)
    }
  })
})
