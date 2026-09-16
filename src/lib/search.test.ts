/**
 * Finding things — the rules, held down.
 *
 * Search is the one feature whose bugs nobody reports. A client that does
 * not come up reads as "we must not have them on file", and the shop goes
 * and enters them a second time. So the behaviours that keep that from
 * happening get tests, not comments.
 */
import { describe, expect, it } from 'vitest'
import { filterBy, marks, matches, normalise, search, tokenise, type SearchItem } from './search'

const item = (over: Partial<SearchItem> & Pick<SearchItem, 'title'>): SearchItem => ({
  kind: 'client',
  id: over.title.toLowerCase().replace(/\W+/g, '-'),
  to: '/clients',
  ...over,
})

const SHOP: SearchItem[] = [
  item({ kind: 'client', title: 'Hafen GmbH', subtitle: 'Ilse Braun', terms: ['ilse@hafen.de', '040 555 118'] }),
  item({ kind: 'client', title: 'Muñoz Studio', subtitle: 'Rafa Muñoz', terms: ['rafa@munoz.es'] }),
  item({ kind: 'client', title: 'Hafenstadt Schule', subtitle: null }),
  item({
    kind: 'project',
    id: 'j1',
    title: 'Bracket, revision C',
    subtitle: 'Hafen GmbH',
    terms: ['GUMA-2026-0184'],
    to: '/project/j1',
  }),
  item({ kind: 'machine', id: 'p1', title: 'Bay 2', subtitle: 'Bambu Lab X1C', to: '/settings' }),
  item({ kind: 'material', id: 'm1', title: 'PETG, black', subtitle: 'Prusament', to: '/settings' }),
]

const titles = (q: string, opts?: Parameters<typeof search>[2]) =>
  search(SHOP, q, opts).map((h) => h.title)

describe('normalising what people type', () => {
  it('folds case, accents and runs of whitespace together', () => {
    expect(normalise('  Muñoz   STUDIO ')).toBe('munoz studio')
  })

  it('breaks a query on punctuation, so a job ref is searchable in pieces', () => {
    expect(tokenise('GUMA-2026-0184')).toEqual(['guma', '2026', '0184'])
    expect(tokenise('   ')).toEqual([])
  })
})

describe('what comes back', () => {
  it('finds a client by the start of their name', () => {
    // The bracket project comes too, because its client is Hafen GmbH --
    // and it comes last, because a match on what a thing is called outranks
    // a match on who it belongs to.
    expect(titles('haf')).toEqual(['Hafen GmbH', 'Hafenstadt Schule', 'Bracket, revision C'])
  })

  it('finds a client by a word in the middle of their name', () => {
    expect(titles('studio')).toEqual(['Muñoz Studio'])
  })

  it('finds a client by something no screen displays — their email', () => {
    expect(titles('ilse@hafen.de')).toContain('Hafen GmbH')
  })

  it('finds a project by part of its reference number', () => {
    expect(titles('0184')).toEqual(['Bracket, revision C'])
  })

  it('finds a project by its client, because that is how shops remember jobs', () => {
    expect(titles('hafen bracket')).toEqual(['Bracket, revision C'])
  })

  it('treats a typed accent and a typed plain letter as the same letter, both ways', () => {
    expect(titles('munoz')).toEqual(['Muñoz Studio'])
    expect(titles('Muñoz')).toEqual(['Muñoz Studio'])
  })
})

describe('every word has to match', () => {
  it('drops a row that matches only one of two words', () => {
    // "Hafen GmbH" matches hafen and nothing else; the bracket project
    // matches both. An OR search would return both and be useless.
    expect(titles('hafen bracket')).toEqual(['Bracket, revision C'])
  })

  it('returns nothing rather than something close', () => {
    expect(titles('brakcet')).toEqual([])
  })

  it('returns nothing at all for an empty query, rather than the whole shop', () => {
    expect(search(SHOP, '')).toEqual([])
    expect(search(SHOP, '   ')).toEqual([])
  })
})

describe('the order of results', () => {
  it('puts an exact name above a name that merely starts the same way', () => {
    expect(titles('hafen')[0]).toBe('Hafen GmbH')
  })

  it('puts a match on the name above a match buried in a subtitle', () => {
    const rows: SearchItem[] = [
      item({ title: 'Somebody Else', subtitle: 'contact: Bracket' }),
      item({ title: 'Bracket Ltd' }),
    ]
    expect(search(rows, 'bracket').map((h) => h.title)).toEqual(['Bracket Ltd', 'Somebody Else'])
  })

  it('puts a shorter name first when two score the same, so the thing beats the mention', () => {
    const rows: SearchItem[] = [
      item({ title: 'Bay 2 spare nozzle assembly' }),
      item({ title: 'Bay 2' }),
    ]
    expect(search(rows, 'bay 2').map((h) => h.title)).toEqual(['Bay 2', 'Bay 2 spare nozzle assembly'])
  })

  it('never reorders two identical rows between calls', () => {
    const rows: SearchItem[] = [
      item({ title: 'Same Name', id: 'b' }),
      item({ title: 'Same Name', id: 'a' }),
    ]
    expect(search(rows, 'same').map((h) => h.id)).toEqual(['a', 'b'])
  })
})

describe('narrowing a search', () => {
  it('can be held to one kind of thing', () => {
    expect(titles('hafen', { kinds: ['project'] })).toEqual(['Bracket, revision C'])
  })

  it('can be cut to a screenful', () => {
    expect(titles('haf', { limit: 1 })).toEqual(['Hafen GmbH'])
  })
})

describe('filtering a list that keeps its own order', () => {
  it('matches everything when nothing has been typed, so an untouched field hides nothing', () => {
    expect(matches(SHOP[0], '')).toBe(true)
    expect(filterBy(SHOP, '  ', (r) => r)).toHaveLength(SHOP.length)
  })

  it('keeps the caller’s order rather than imposing a score order', () => {
    const rows = [item({ title: 'Zed Hafen' }), item({ title: 'Hafen GmbH' })]
    expect(filterBy(rows, 'hafen', (r) => r).map((r) => r.title)).toEqual(['Zed Hafen', 'Hafen GmbH'])
  })

  it('removes the rows that do not match', () => {
    expect(filterBy(SHOP, 'petg', (r) => r).map((r) => r.title)).toEqual(['PETG, black'])
  })
})

describe('showing people which letters matched', () => {
  it('splits a name into matched and unmatched runs', () => {
    expect(marks('Hafen GmbH', 'haf')).toEqual([
      { text: 'Haf', hit: true },
      { text: 'en GmbH', hit: false },
    ])
  })

  it('highlights every word of a multi-word query', () => {
    expect(marks('Bracket, revision C', 'bracket revision')).toEqual([
      { text: 'Bracket', hit: true },
      { text: ', ', hit: false },
      { text: 'revision', hit: true },
      { text: ' C', hit: false },
    ])
  })

  it('highlights the accented letters an unaccented query matched', () => {
    expect(marks('Muñoz', 'munoz')).toEqual([{ text: 'Muñoz', hit: true }])
  })

  it('leaves text whole when nothing matched, and when nothing was typed', () => {
    expect(marks('Hafen GmbH', 'zzz')).toEqual([{ text: 'Hafen GmbH', hit: false }])
    expect(marks('Hafen GmbH', '')).toEqual([{ text: 'Hafen GmbH', hit: false }])
  })
})
