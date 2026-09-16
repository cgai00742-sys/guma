/**
 * The stylesheet is a contract, and this holds it.
 *
 * The bug that produced this file: `.row` is the design system's flex
 * list-row utility, and two screens put it on a `<tr>`. That set
 * display:flex on a table row, which takes the row out of the table —
 * its cells stop being table cells, stop participating in the column
 * widths, and every row sizes itself independently. The header said
 * CLIENT, TYPE, PROJECTS in one place and the rows put their values
 * somewhere else entirely, money and dates wrapped mid-value, and
 * expanding a row regrouped the browser's anonymous table boxes so the
 * other rows visibly moved.
 *
 * It shipped. It was in front of everyone the whole time, and 295 tests
 * did not notice, because a test that renders into jsdom — which does no
 * layout at all — cannot see where anything is. This class of bug is
 * invisible to every test in this repo, so it gets caught the only other
 * way available: by reading what the stylesheet says about the classes
 * the app actually uses.
 *
 * Two rules, both about the same thing — the app and the stylesheet
 * disagreeing quietly:
 *
 *   1. A class on a table element may not change that element's display.
 *   2. Every class the app uses must exist somewhere.
 *
 * Neither needs a browser, and neither can be satisfied by accident.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS_FILES = ['public/guma.css', 'src/index.css']

/** Every .tsx the app ships, tests excluded — a test file's markup is not
 *  what anyone looks at. */
function screens(dir = 'src', out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) screens(path, out)
    else if (path.endsWith('.tsx') && !path.includes('.test.')) out.push(path)
  }
  return out
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule {
  selector: string
  classes: Set<string>
  display: string | null
}

function rulesOf(css: string): Rule[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const selector = m[1].trim().replace(/\s+/g, ' ')
    const display = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(m[2])
    return {
      selector,
      classes: new Set([...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((c) => c[1])),
      display: display ? display[1].trim() : null,
    }
  })
}

const allRules = CSS_FILES.flatMap((f) => rulesOf(readFileSync(f, 'utf8')))
const definedClasses = new Set(allRules.flatMap((r) => [...r.classes]))

/** Where a class is used: which file, which line, and on what element. */
interface Use {
  file: string
  line: number
  element: string
  cls: string
}

function usesIn(file: string): Use[] {
  const src = readFileSync(file, 'utf8')
  const out: Use[] = []
  for (const m of src.matchAll(/className=(?:"([^"{}]*)"|\{`([^`]*)`\})/g)) {
    // A template literal's interpolations are runtime values; its static
    // words are still real class names and still worth checking. An
    // interpolation becomes a marker rather than a space, so that a
    // fragment glued to one -- the `p-` of `p-${phase}` -- is recognised as
    // half a class name and skipped, instead of being reported as a class
    // nobody defined.
    const MARKER = '\u0000'
    const literal = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, MARKER)
    const open = src.lastIndexOf('<', m.index)
    const element = /^<\s*([A-Za-z][A-Za-z0-9.]*)/.exec(src.slice(open, m.index))?.[1] ?? '?'
    const line = src.slice(0, m.index).split('\n').length
    for (const cls of literal.split(/\s+/).filter((c) => c && !c.includes(MARKER))) {
      out.push({ file, line, element, cls })
    }
  }
  return out
}

const uses = screens().flatMap(usesIn)

/** What each of these elements has to keep being. */
const TABLE_DISPLAY: Record<string, string> = {
  tr: 'table-row',
  td: 'table-cell',
  th: 'table-cell',
  thead: 'table-header-group',
  tbody: 'table-row-group',
  table: 'table',
}

describe('a class on a table element cannot stop it being a table element', () => {
  it('finds no class that takes a row or a cell out of its table', () => {
    const broken: string[] = []

    for (const use of uses) {
      const required = TABLE_DISPLAY[use.element]
      if (!required) continue

      const setters = allRules.filter((r) => r.display && r.classes.has(use.cls))
      if (setters.length === 0) continue

      // A rule naming the element too (tr.row) is more specific than the
      // bare class (.row) and is how a shared utility is legitimately made
      // safe on a table. Anything else wins by source order and breaks it.
      const restored = setters.some(
        (r) => r.selector.includes(`${use.element}.${use.cls}`) && r.display === required,
      )
      if (restored) continue

      for (const r of setters) {
        broken.push(
          `${use.file}:${use.line} — <${use.element} className="${use.cls}"> gets ` +
            `display:${r.display} from \`${r.selector}\`, so it stops being a ${required}. ` +
            `Add \`${use.element}.${use.cls}{display:${required}}\` or use a different class.`,
        )
      }
    }

    expect(broken).toEqual([])
  })

  it('still knows what it is looking at', () => {
    // A guard on the guard. If the className scan ever silently stops
    // matching — a syntax change, a bad regex edit — the test above starts
    // passing vacuously, which is worse than it failing.
    expect(uses.length).toBeGreaterThan(100)
    expect(uses.some((u) => u.element === 'tr')).toBe(true)
    expect(definedClasses.has('row')).toBe(true)
  })
})

describe('every class the app uses is a class that exists', () => {
  it('finds no className that no stylesheet defines', () => {
    const orphans = new Map<string, Use>()
    for (const use of uses) {
      if (definedClasses.has(use.cls)) continue
      // A screen that prints (QuoteDoc, Closeout) injects its own rules as
      // a string rather than putting page-specific print CSS in the design
      // system. Those count as defined, for that file only.
      const own = readFileSync(use.file, 'utf8')
      if (new RegExp(`\\.${use.cls}\\s*\\{`).test(own)) continue
      if (!orphans.has(use.cls)) orphans.set(use.cls, use)
    }

    expect(
      [...orphans.values()].map(
        (u) => `${u.file}:${u.line} — className="${u.cls}" is not defined in any stylesheet`,
      ),
    ).toEqual([])
  })
})
