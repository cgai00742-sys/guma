#!/usr/bin/env node
/**
 * Repair a local Guma database whose migration checksums have drifted.
 *
 * WHEN YOU NEED THIS
 *   The app refuses to open with:
 *     "migration N was previously applied but has been modified"
 *
 *   sqlx hashes every migration file and stores the hash when it applies
 *   it. If the file changes afterwards the hash no longer matches and it
 *   stops rather than run against a schema it cannot vouch for. That is
 *   correct behaviour and worth keeping. The mistake is upstream, in
 *   editing a migration that had already been applied.
 *
 * WHAT IT DOES
 *   Backs the database up, re-points each drifted checksum at the current
 *   file, and rebuilds every view (the one kind of statement in these
 *   files that can safely be re-run, and the likeliest thing an edited
 *   migration left stale).
 *
 * WHAT IT CANNOT DO
 *   Invent a column a corrected migration would have added. If a repaired
 *   database still misbehaves, delete it and start clean -- the app
 *   rebuilds from empty on next launch, and for a shop not yet live that
 *   is usually the faster answer anyway.
 *
 * Written in Node rather than shell so it could be tested end to end
 * before being handed to anyone: node:sqlite is built in, the sqlite3 CLI
 * is not always present, and a script that writes to somebody's data
 * should not be its own first test.
 *
 *   node scripts/repair-migrations.mjs            # repair in place
 *   node scripts/repair-migrations.mjs --dry-run  # show what would change
 *   GUMA_DB=/path/to/guma.db node scripts/repair-migrations.mjs
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', 'src-tauri', 'migrations')
const DB =
  process.env.GUMA_DB ??
  join(homedir(), 'Library', 'Application Support', 'house.guma.app', 'guma.db')
const dryRun = process.argv.includes('--dry-run')

/** Exactly what sqlx stores: SHA-384 over the migration file's bytes. */
const checksumOf = (file) => createHash('sha384').update(readFileSync(file)).digest('hex')

/**
 * Every `create view … ;` block across the migrations, in file order —
 * restricted to migrations that have ALREADY been applied.
 *
 * That restriction is load-bearing and was found by testing rather than by
 * thinking. Rebuilding a view from a migration that has not run yet leaves
 * the view in place, and the migration then dies on "view already exists"
 * the moment the app starts. SQLite does not validate a view's referenced
 * tables at CREATE time, so nothing complains until it is too late to be
 * obvious.
 */
export function viewStatements(dir, appliedVersions) {
  const out = []
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (!appliedVersions.has(Number(name.split('_')[0]))) continue
    const sql = readFileSync(join(dir, name), 'utf8')
    const re = /^create view\s+(\w+)\s+as\b/gim
    let m
    while ((m = re.exec(sql)) !== null) {
      // A view definition runs to the first semicolon at end of line. These
      // files have no semicolons inside a view body, and the test alongside
      // this script asserts every extracted block actually executes.
      const end = sql.indexOf(';', m.index)
      if (end === -1) continue
      out.push({ name: m[1], sql: sql.slice(m.index, end + 1) })
    }
  }
  return out
}

export function drift(db, dir) {
  const rows = []
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const version = Number(name.split('_')[0])
    const want = checksumOf(join(dir, name))
    const found = db
      .prepare('select lower(hex(checksum)) as have from _sqlx_migrations where version = ?')
      .get(version)
    rows.push({
      name,
      version,
      want,
      have: found?.have ?? null,
      state: !found ? 'not applied yet' : found.have === want ? 'matches' : 'DRIFTED',
    })
  }
  return rows
}

function main() {
  if (!existsSync(DB)) {
    console.log(`No database at:\n  ${DB}\n`)
    console.log('Nothing to repair — the app creates one on next launch.')
    console.log('(Set GUMA_DB=/path/to/guma.db if yours lives elsewhere.)')
    return
  }
  console.log(`Database:   ${DB}`)
  console.log(`Migrations: ${MIGRATIONS}\n`)

  const db = new DatabaseSync(DB)
  let applied
  try {
    applied = db.prepare('select version, description from _sqlx_migrations order by version').all()
  } catch {
    console.log('No _sqlx_migrations table — this database predates migration tracking.')
    return
  }
  console.log('Applied so far:')
  for (const a of applied) console.log(`  ${a.version}  ${a.description}`)
  console.log()

  const rows = drift(db, MIGRATIONS)
  for (const r of rows) console.log(`  ${r.name.padEnd(32)} ${r.state}`)
  console.log()

  const bad = rows.filter((r) => r.state === 'DRIFTED')
  if (bad.length === 0) {
    console.log('No checksum drift. If the app still will not open, the problem is elsewhere.')
    return
  }

  const views = viewStatements(MIGRATIONS, new Set(applied.map((a) => Number(a.version))))
  if (dryRun) {
    console.log('Dry run — would:')
    for (const r of bad) console.log(`  re-point migration ${r.version} at ${r.name}`)
    for (const v of views) console.log(`  rebuild view ${v.name}`)
    return
  }

  const backup = `${DB}.backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  copyFileSync(DB, backup)
  console.log(`Backed up to: ${backup}`)

  db.exec('begin')
  try {
    for (const r of bad) {
      db.prepare('update _sqlx_migrations set checksum = unhex(?) where version = ?').run(
        r.want,
        r.version,
      )
    }
    for (const v of views) db.exec(`drop view if exists ${v.name}`)
    for (const v of views) db.exec(v.sql)
    db.exec('commit')
  } catch (e) {
    db.exec('rollback')
    console.error('\nRepair failed, nothing changed:', e.message)
    console.error(`Your database is untouched; the backup at ${backup} is identical.`)
    process.exitCode = 1
    return
  }

  console.log(
    `\nRe-pointed ${bad.length} checksum(s) and rebuilt ${views.length} view(s): ` +
      views.map((v) => v.name).join(', '),
  )
  console.log('Start the app again.')
}

// Compare resolved paths, not URL strings: import.meta.url percent-encodes,
// and this project lives under a directory with a space in its name, so the
// naive `file://${process.argv[1]}` form silently never matches and the
// script does nothing at all. Found by running it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
