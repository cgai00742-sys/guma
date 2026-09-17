/**
 * The rate somebody types has to be the rate the program reads back.
 *
 * This one is worth a real database rather than a mock. The bug was not in
 * the payload -- the wizard sent design_hourly: 65 and the insert stored it
 * correctly. The bug was in the SELECT: two rate cards on the same day, a
 * tie on effective_from, and the old one winning. A mocked backend would
 * have passed happily. So this runs the SHIPPED schema against real SQLite
 * and asks the question a person asks: I typed a rate, what does it say now?
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LATEST_RATE_CARD } from './rateCards'

/** The real create table, lifted out of the migration rather than retyped,
 *  so this test cannot quietly drift away from what actually ships. */
function rateCardsDDL(): string {
  const sql = readFileSync(new URL('../../src-tauri/migrations/0001_initial.sql', import.meta.url), 'utf8')
  const at = sql.indexOf('create table rate_cards')
  expect(at, 'rate_cards is not in 0001_initial.sql any more').toBeGreaterThan(-1)
  return sql.slice(at, sql.indexOf(');', at) + 2)
}

/** A shop as the wizard leaves it: a card written when the shop was created,
 *  then a second one when the rate question was answered. Same day, because
 *  that is the ordinary case, not the unlucky one. */
function twoCardsOneDay() {
  const db = new DatabaseSync(':memory:')
  db.exec(rateCardsDDL().replace(/references[^,\n]*/g, ''))
  const insert = `insert into rate_cards
      (id, shop_id, design_hourly, finishing_hourly, rush_pct, minimum_order,
       deposit_pct, deposit_when, deposit_waive_below, material_markup,
       revisions_incl, revision_hourly)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  // Written by setupShop on the wizard's first answer: no rates yet.
  db.prepare(insert).run('card-a', 'shop-1', 0, 0, 0, 0, 0, 'design', 0, 1, 0, null)
  // Written seven questions later: "what is an hour of your time worth?"
  db.prepare(insert).run('card-b', 'shop-1', 65, 0, 0, 0, 0, 'design', 0, 1, 0, null)
  return db
}

describe('the rate card in force', () => {
  it('is the one entered last when two share a day', () => {
    const db = twoCardsOneDay()
    const row = db
      .prepare(`select * from rate_cards where shop_id = ? ${LATEST_RATE_CARD} limit 1`)
      .get('shop-1') as { id: string; design_hourly: number }
    expect(row.design_hourly).toBe(65)
    expect(row.id).toBe('card-b')
  })

  it('is genuinely ambiguous without the tie-break, which is the bug', () => {
    // Kept as evidence rather than as a rule: this asserts the OLD query
    // returns the stale card, so nobody reads the fix above and wonders
    // whether the extra clause was ever doing anything.
    const db = twoCardsOneDay()
    const row = db
      .prepare('select * from rate_cards where shop_id = ? order by effective_from desc limit 1')
      .get('shop-1') as { id: string; design_hourly: number }
    expect(row.id).toBe('card-a')
    expect(row.design_hourly).toBe(0)
  })

  it('still prefers a later effective date over a later entry', () => {
    // The tie-break is a tie-break. A card dated tomorrow beats one entered
    // after it but dated today, because effective_from is the real answer
    // whenever it has one to give.
    const db = twoCardsOneDay()
    db.prepare(
      `insert into rate_cards
        (id, shop_id, effective_from, design_hourly, finishing_hourly, rush_pct,
         minimum_order, deposit_pct, deposit_when, deposit_waive_below,
         material_markup, revisions_incl, revision_hourly)
       values (?, ?, date('now', '+1 day'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('card-c', 'shop-1', 90, 0, 0, 0, 0, 'design', 0, 1, 0, null)
    db.prepare(
      `insert into rate_cards
        (id, shop_id, design_hourly, finishing_hourly, rush_pct, minimum_order,
         deposit_pct, deposit_when, deposit_waive_below, material_markup,
         revisions_incl, revision_hourly)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('card-d', 'shop-1', 70, 0, 0, 0, 0, 'design', 0, 1, 0, null)

    const row = db
      .prepare(`select * from rate_cards where shop_id = ? ${LATEST_RATE_CARD} limit 1`)
      .get('shop-1') as { id: string }
    expect(row.id).toBe('card-c')
  })
})
