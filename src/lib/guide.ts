/**
 * What Guma explains, and when it decides to.
 *
 * The rule the whole file exists to enforce: a chapter appears the first
 * time a shop reaches the thing it is about, and never again. Not on
 * launch, not in a queue, not three at once. A program that explains itself
 * at the moment of need is being helpful; the same sentences fired at
 * signup are an obstacle course between somebody and the thing they opened
 * the app to do.
 *
 * Three constraints, all enforced below rather than promised:
 *
 * ONE AT A TIME. `nextChapter` returns a single chapter or nothing. Two
 * modals in a row teaches people to dismiss modals, which costs more than
 * the second one was worth.
 *
 * ONLY WHEN IT IS TRUE. Every chapter carries a `when` predicate over the
 * shop's actual state. The in-house chapter does not fire for a shop that
 * has already logged in-house work; the rate-versioning one does not fire
 * before there is a quote that could be affected. A chapter that explains
 * something the user has already worked out is noise wearing a helpful
 * face.
 *
 * SHORT ENOUGH TO READ. Three points maximum, and the tests fail a body
 * over 240 characters. Every previous version of guidance in this app has
 * had to be cut down after somebody looked at it; this time the limit is
 * in the suite.
 */

/** The state a chapter's trigger can ask about. Deliberately small: if a
 *  chapter needs to know something not in here, that is a sign it is about
 *  the wrong moment. */
export interface GuideState {
  /** Screen the user is on now, in the app's own route vocabulary. */
  screen: 'projects' | 'clients' | 'project' | 'settings' | 'intake'
  /** Projects on file, billed work only. */
  clientJobs: number
  /** In-house jobs on file. */
  inHouseJobs: number
  /** Quotes ever sent. */
  quotesSent: number
  /** Machine hours logged across everything. */
  loggedHours: number
  /** True once the shop has a printer with both wear and wattage on file. */
  machineCostComplete: boolean
}

export interface Chapter {
  id: string
  title: string
  /** One sentence of what this is. */
  lede: string
  /** At most three. Each one short enough to take in at a glance. */
  points: string[]
  /** Optional call to action; the screen decides what it does. */
  action?: string
  /** Fires only when this is true AND the chapter has not been seen. */
  when: (s: GuideState) => boolean
}

export const CHAPTERS: Chapter[] = [
  {
    id: 'in-house',
    title: 'Work nobody is paying for',
    lede: 'Test prints, failed experiments and your own designs cost real money. Guma can now see them.',
    points: [
      'Log them as in-house jobs — no client, no quote, no invoice.',
      'They still record material, machine hours and your time.',
      'Guma uses them to tell you what share of your week is actually billable.',
    ],
    action: 'Start an in-house job',
    // The moment somebody is looking at their list of work for the first
    // time with something on it, and has no in-house job yet.
    when: (s) => s.screen === 'projects' && s.clientJobs >= 1 && s.inHouseJobs === 0,
  },
  {
    id: 'machine-cost',
    title: 'Your margin is reading low',
    lede: 'Without a wattage and an electricity rate, Guma prices machine time at break-even and says so.',
    points: [
      'It will not guess — a made-up power cost is worse than a missing one.',
      'Add both and every quote starts showing a real margin instead of a floor.',
      'Settings → Machines for the wattage, Identity for your rate.',
    ],
    action: 'Fix it now',
    when: (s) => s.screen === 'projects' && s.quotesSent >= 1 && !s.machineCostComplete,
  },
  {
    id: 'rates-versioned',
    title: 'Changing a rate is safe',
    lede: 'A quote keeps the numbers it was priced with. Nothing a client already holds moves.',
    points: [
      'Saving here writes a new rate card and affects new quotes only.',
      'So you can raise a rate without rewriting history or chasing anyone.',
    ],
    when: (s) => s.screen === 'settings' && s.quotesSent >= 1,
  },
  {
    id: 'actuals',
    title: 'Quoted is not the same as spent',
    lede: 'Logging what a job really took is what turns Guma from a calculator into a record.',
    points: [
      'Record runs and hours as you go, on the project itself.',
      'Guma compares them to the quote and shows where the estimate was wrong.',
      'A few jobs in, it starts suggesting from your numbers instead of published ones.',
    ],
    when: (s) => s.screen === 'project' && s.quotesSent >= 1 && s.loggedHours === 0,
  },
]

/**
 * The one chapter to show right now, or null.
 *
 * Order in CHAPTERS is priority order, so a shop that qualifies for two
 * gets the earlier one and meets the other on a later visit. Deliberately
 * not a queue: the second modal in a session is the one that teaches people
 * to stop reading them.
 */
export function nextChapter(state: GuideState, seen: Iterable<string>): Chapter | null {
  const done = new Set(seen)
  return CHAPTERS.find((c) => !done.has(c.id) && c.when(state)) ?? null
}

/** Look one up by id, for a screen that wants to offer it on demand. */
export function chapterById(id: string): Chapter | null {
  return CHAPTERS.find((c) => c.id === id) ?? null
}
