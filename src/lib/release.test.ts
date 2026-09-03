/// <reference types="node" />
/**
 * The things that quietly disagree between releases.
 *
 * A version number lives in three files here — package.json, Cargo.toml and
 * tauri.conf.json — and only one of them names the installer a user
 * downloads. They drifted before this test existed (0.0.0, 0.1.0 and 0.1.0
 * at the same commit), which is the sort of thing nobody notices until a
 * bug report says "1.0" and the binary says something else.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const pkg = JSON.parse(read('package.json'))
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'))
const cargo = read('src-tauri/Cargo.toml').match(/^version = "(.+)"/m)?.[1]

describe('the release is coherent', () => {
  it('all three version numbers agree', () => {
    expect(tauri.version, 'src-tauri/tauri.conf.json').toBe(pkg.version)
    expect(cargo, 'src-tauri/Cargo.toml').toBe(pkg.version)
  })

  it('the version is a plain semver, not a placeholder', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.version).not.toBe('0.0.0')
  })

  it('the changelog has an entry for the current version', () => {
    // A release whose changelog stops at the previous version is a release
    // nobody can read the diff of.
    expect(read('CHANGELOG.md')).toContain(`## ${pkg.version}`)
  })

  it('every script the README tells people to run actually exists', () => {
    const readme = read('README.md')
    const scripts = new Set(Object.keys(pkg.scripts))
    const promised = [...readme.matchAll(/^npm run ([\w:]+)/gm)].map((m) => m[1])
    for (const name of promised) {
      expect(scripts.has(name), `README documents "npm run ${name}" but package.json has no such script`).toBe(true)
    }
    expect(promised.length).toBeGreaterThan(2)
  })

  it('the licence is the one the README and CONTRIBUTING claim', () => {
    const licence = read('LICENSE')
    expect(licence).toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
    // AGPL is a deliberate, hard-to-reverse choice (see the project board):
    // network copyleft is what keeps a hosted tier worth running. If this
    // ever changes it should be a decision, not a drift.
    expect(licence).toContain('Version 3')
  })
})
