/**
 * Finding things.
 *
 * A shop with forty projects, sixty clients and nine spools does not have a
 * browsing problem, it has a finding problem, and Guma had no answer to it
 * at all: the Clients screen offered a type filter and a sort order, the
 * project list offered five sort keys, and neither offered the one thing
 * anybody actually does, which is type part of a name and expect the list
 * to get shorter.
 *
 * So: one matcher, used everywhere. The per-screen filter fields and the
 * global search in the top bar run the same function over the same shape,
 * which is why a client that turns up in one always turns up in the other.
 *
 * Three decisions worth stating, because each of them is a way search
 * quietly lies to people:
 *
 *   Every token must match.  Typing "hafen bracket" means both, not either.
 *   An OR search feels cleverer and is useless the moment a shop has more
 *   than a screenful of anything — the second word is supposed to narrow.
 *
 *   Accents do not count.  A shop typing "munoz" finds Muñoz, and a shop
 *   typing "Muñoz" finds a client somebody entered as "Munoz" three months
 *   ago on a keyboard that could not do the tilde. Both of those are the
 *   same person and a tool that disagrees is wrong.
 *
 *   Nothing is fuzzy.  No edit distance, no transposition forgiveness. A
 *   search that returns things you did not ask for teaches people not to
 *   trust the list, and the cost of that — scanning results you already
 *   rejected — is paid on every single search, whereas the cost of a typo
 *   is paid on the rare one. Substring matching is forgiving enough to
 *   survive "brack" and strict enough that an empty result means "you do
 *   not have one of those", which is itself a useful answer.
 */

/** What can be found. Ordered the way results are grouped. */
export const SEARCH_KINDS = ['project', 'client', 'machine', 'material'] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]

export const KIND_LABEL: Record<SearchKind, string> = {
  project: 'Projects',
  client: 'Clients',
  machine: 'Machines',
  material: 'Materials',
}

/**
 * One findable thing, flattened.
 *
 * Every screen builds these from rows it already has in hand — there is no
 * separate index to keep in step with the database, because an index that
 * can go stale is a search that can tell you a client does not exist.
 */
export interface SearchItem {
  kind: SearchKind
  id: string
  /** What it is called. Weighted heaviest, and what gets highlighted. */
  title: string
  /** The line underneath. Matched, and shown. */
  subtitle?: string | null
  /**
   * Matched but not shown: job refs, emails, phone numbers, model names.
   * A shop searching a phone number off a missed call should land on the
   * client even though no screen displays the number in the result row.
   */
  terms?: (string | null | undefined)[]
  /** Right-hand side of the result row — money, a stage, a status. */
  badge?: string | null
  /** Where selecting it goes. */
  to: string
}

export interface SearchHit extends SearchItem {
  score: number
}

/**
 * Lowercase, unaccented, single-spaced.
 *
 * NFD splits a letter from its accent and the range strip removes the
 * accent, so "Muñoz" and "Munoz" become the same string. Supported
 * everywhere Guma runs; there is no polyfill branch here on purpose.
 */
export function normalise(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** A query into the words it is made of. Punctuation is a separator, which
 *  is what makes "GUMA-2026-0184" findable by typing "2026 184". */
export function tokenise(query: string): string[] {
  return normalise(query)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * How well one token matches one field, 0 for not at all.
 *
 * The gaps between the tiers are wide deliberately. A client actually
 * called "Bay" should sit above a machine whose model happens to contain
 * "bay", and no amount of weaker matches in other fields should add up to
 * overtake it.
 */
function scoreField(field: string, token: string): number {
  if (!field) return 0
  if (field === token) return 100
  if (field.startsWith(token)) return 60
  // Word-start anywhere: "hafen" finding "Hotel Hafen Hamburg".
  if (field.includes(' ' + token)) return 40
  if (field.includes(token)) return 20
  return 0
}

interface Prepared {
  item: SearchItem
  title: string
  rest: string[]
}

function prepare(item: SearchItem): Prepared {
  return {
    item,
    title: normalise(item.title),
    rest: [item.subtitle, ...(item.terms ?? [])]
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .map(normalise),
  }
}

/**
 * One item against an already-tokenised query.
 *
 * Returns null rather than 0 for "no match", so the AND rule is enforced by
 * the type rather than by remembering to check a falsy number — a token
 * that matches nothing takes the whole item out, however well the others
 * scored.
 */
function scoreItem(p: Prepared, tokens: string[]): number | null {
  let total = 0
  let titleHits = 0
  for (const token of tokens) {
    // Title counts double: matching what a thing is called beats matching
    // something buried in its contact details.
    const inTitle = scoreField(p.title, token) * 2
    let best = inTitle
    for (const field of p.rest) {
      const s = scoreField(field, token)
      if (s > best) best = s
    }
    if (best === 0) return null
    if (inTitle > 0) titleHits++
    total += best
  }
  // Every token in the title is a different quality of match from tokens
  // scattered across four fields, and worth saying so.
  if (titleHits === tokens.length) total += 25
  return total
}

export interface SearchOptions {
  /** Cut the list at this many. The palette wants a screenful; a screen
   *  filter wants all of them, so this is opt-in. */
  limit?: number
  /** Only these kinds. */
  kinds?: readonly SearchKind[]
}

/**
 * Rank items against a query.
 *
 * An empty query returns nothing rather than everything. Callers that want
 * "everything when nothing is typed" — which is every per-screen filter —
 * say so themselves, and the ones that do not want it (the palette, which
 * would otherwise dump the entire shop on screen the moment it opens) get
 * the safe answer by default.
 */
export function search(
  items: readonly SearchItem[],
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const tokens = tokenise(query)
  if (tokens.length === 0) return []
  const kinds = opts.kinds
  const hits: SearchHit[] = []
  for (const item of items) {
    if (kinds && !kinds.includes(item.kind)) continue
    const p = prepare(item)
    const score = scoreItem(p, tokens)
    if (score == null) continue
    hits.push({ ...item, score })
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      // Shorter title first: "Bay 2" before "Bay 2 spare nozzle assembly",
      // because a shorter name containing the query is more likely to BE
      // the thing than to merely mention it.
      a.title.length - b.title.length ||
      a.title.localeCompare(b.title) ||
      // Never let two equal rows swap places between renders.
      a.id.localeCompare(b.id),
  )
  return opts.limit != null ? hits.slice(0, opts.limit) : hits
}

/**
 * Does this one thing match? For per-screen filtering, where the list keeps
 * its own sort order and search is only being asked to remove rows.
 *
 * An empty query matches everything, which is the opposite of search()'s
 * answer and is right for the same reason: a filter field nobody has typed
 * in must not hide the list.
 */
export function matches(item: SearchItem, query: string): boolean {
  const tokens = tokenise(query)
  if (tokens.length === 0) return true
  return scoreItem(prepare(item), tokens) != null
}

/**
 * Filter a list of rows by a query, using a function that says how to read
 * each row as a searchable thing. Keeps the caller's order untouched.
 */
export function filterBy<T>(
  rows: readonly T[],
  query: string,
  as: (row: T) => SearchItem,
): T[] {
  if (tokenise(query).length === 0) return [...rows]
  return rows.filter((row) => matches(as(row), query))
}

/**
 * Text split into matched and unmatched runs, for bolding the part someone
 * typed. Works on the original string, not the normalised one, so accents
 * and capitals survive into what is drawn.
 */
export interface Mark {
  text: string
  hit: boolean
}

export function marks(text: string, query: string): Mark[] {
  const tokens = tokenise(query)
  if (tokens.length === 0 || !text) return [{ text, hit: false }]
  // normalise() can change length (it collapses runs of whitespace), and an
  // index from a string of a different length would highlight the wrong
  // letters. Fold per character instead, so position is preserved exactly.
  const folded = Array.from(text)
    .map((ch) => {
      const f = ch
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
      // Almost every character folds to exactly one. The handful that do
      // not -- the German sharp s, the dotted capital I -- would shift
      // every index after them and highlight the wrong letters, so they
      // are left alone. They just do not get highlighted; nothing breaks.
      return f.length === 1 ? f : ch
    })
    .join('')
  const hit = new Array<boolean>(text.length).fill(false)
  let any = false
  for (const token of tokens) {
    let from = 0
    for (;;) {
      const at = folded.indexOf(token, from)
      if (at < 0) break
      for (let i = at; i < at + token.length && i < hit.length; i++) hit[i] = true
      any = true
      from = at + token.length
    }
  }
  if (!any) return [{ text, hit: false }]
  const out: Mark[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || hit[i] !== hit[start]) {
      out.push({ text: text.slice(start, i), hit: hit[start] })
      start = i
    }
  }
  return out
}
