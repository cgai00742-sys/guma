/// <reference types="node" />
/**
 * Every database file the app can open must be one the desktop shell
 * migrates.
 *
 * The bug this exists for: tauri-plugin-sql only runs migrations against a
 * file it was registered for, and the demo workspace (guma-demo.db) never
 * was. Opening it produced a database with no tables -- "no such table:
 * shops" on launch -- and because the chosen workspace is remembered, the
 * app reopened the broken demo every time. Reported as "App is down."
 *
 * No other test could see it. Every render and data test stands the plugin
 * in with node:sqlite and migrates whatever file it is handed, so the demo
 * looked fine in all of them. The only place the truth lives is lib.rs, so
 * this reads lib.rs.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FILES } from './workspace'

const here = dirname(fileURLToPath(import.meta.url))
const LIB_RS = readFileSync(join(here, '../../src-tauri/src/lib.rs'), 'utf8')

describe('the desktop shell migrates every workspace', () => {
  for (const [name, file] of Object.entries(FILES)) {
    it(`registers migrations for the ${name} workspace (${file})`, () => {
      expect(LIB_RS).toContain(`.add_migrations("sqlite:${file}", migrations())`)
    })
  }

  it('gives each file the SAME list, so the demo cannot drift behind the shop', () => {
    // One function, called once per file. A second hand-written list is a
    // list somebody forgets to append to.
    expect(LIB_RS).toMatch(/fn migrations\(\) -> Vec<tauri_plugin_sql::Migration>/)
    const calls = LIB_RS.match(/\.add_migrations\(/g) ?? []
    expect(calls.length).toBe(Object.keys(FILES).length)
  })

  it('names every migration the way lib.rs imports it (CG, 8 Oct: E0422)', () => {
    // There is no Rust compiler in the test run, and lib.rs does not
    // \`use\` Migration -- a bare \`Migration {\` passed every test and then
    // stopped \`tauri dev\` from compiling on CG's Mac.
    const bare = LIB_RS.match(/^\s+Migration \{/gm) ?? []
    expect(bare).toEqual([])
    const versions = [...LIB_RS.matchAll(/tauri_plugin_sql::Migration \{\s*version: (\d+)/g)].map((m) => Number(m[1]))
    expect(versions).toEqual(versions.map((_, i) => i + 1))
  })
})

describe('the desktop window lets a file be dropped on the page', () => {
  /**
   * Tauri's window takes file drops for itself by default, so a G-code
   * dragged onto "Drop a sliced file here" never reached the page: no
   * import, no error, nothing. jsdom has no such window, so every render
   * test passed. This is the only place the setting can be checked.
   */
  it('turns the native drop handler off', () => {
    const conf = JSON.parse(readFileSync(join(here, '../../src-tauri/tauri.conf.json'), 'utf8'))
    for (const w of conf.app.windows) expect(w.dragDropEnabled).toBe(false)
  })
})
