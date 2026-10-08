/**
 * Projects — one tab, two views.
 *
 * Guma had these as two separate top-level tabs ("Projects" and
 * "Pipeline"), which is one tab too many for what is the same set of rows
 * asked two different questions. Voltage gets this right: one Pipeline tab
 * with a Board / List switch sitting in the header, because choosing how
 * to look at your projects is not the same kind of decision as choosing
 * whether to look at projects or clients.
 *
 * The two views stay in their own files. The board's whole layout depends
 * on guma.css's `body:has(.board)` / `.wrap:has(.board)` flex chain, which
 * needs the board to be inside its own .wrap — so this component renders
 * neither a wrapper nor a header of its own. It owns the choice, hands each
 * view the switch to render in its existing header, and gets out of the way.
 *
 * The choice is remembered for the session (not the browser) on purpose: a
 * shop that lives on the board should not have to re-pick it every time it
 * comes back from a project, and a preference that outlives the session is
 * a preference that needs a settings screen to undo.
 */
import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Jobs from './Jobs'
import Pipeline from './Pipeline'
import { planFor } from '../lib/setupPlan'
import type { ShopContext } from '../lib/data'

type View = 'board' | 'list'

export default function Projects({ ctx }: { ctx: ShopContext }) {
  // Kept in the URL as well as in state, so a view can be linked to and
  // survives a reload — the same reason the project page is a page.
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  // Read from the URL on every render, not copied into state once: a link
  // to this same route (the board's "N drafts →" chip goes to
  // ?view=list&show=drafts) does not remount the page, so a copy taken at
  // mount would leave the board on screen under a list URL.
  const view: View = params.get('view') === 'list' ? 'list' : 'board'

  function choose(next: View) {
    const p = new URLSearchParams(params)
    if (next === 'board') p.delete('view')
    else p.set('view', next)
    setParams(p, { replace: true })
  }

  const viewSwitch = (
    <div className="seg" role="group" aria-label="How to view projects" style={{ marginLeft: 'auto' }}>
      <button type="button" aria-pressed={view === 'board'} onClick={() => choose('board')}>
        Board
      </button>
      <button type="button" aria-pressed={view === 'list'} onClick={() => choose('list')}>
        List
      </button>
    </div>
  )

  /**
   * How far through setting up this shop is.
   *
   * It lives HERE rather than in either view, because it belongs to both.
   * It was originally written into the list view, where the default board
   * view meant nobody ever saw it -- a banner about an unconfigured shop is
   * worthless on the one screen most people never open.
   */
  const plan = useMemo(
    () =>
      planFor({
        shop: ctx.shop,
        rateCard: ctx.rateCard,
        printerRows: ctx.printerRows,
        materials: ctx.materials as never,
      }),
    [ctx],
  )

  const banner = plan.done ? null : (
    <div className="wrap" style={{ paddingTop: 16, paddingBottom: 0 }}>
      <div className={plan.distorting.length > 0 ? 'attn crit' : 'notice'} style={{ margin: 0 }}>
        <span>
          <b>
            {plan.distorting.length > 0
              ? 'Your numbers are not right yet.'
              : `${Math.round(plan.completeness * 100)}% configured.`}
          </b>{' '}
          {plan.distorting.length > 0
            ? plan.distorting[0].cost
            : `Still to do: ${plan.remaining.map((s) => s.title.toLowerCase()).join(', ')}.`}{' '}
          <button type="button" className="addnote" onClick={() => navigate('/setup-guide')}>
            {plan.distorting.length > 0 ? 'finish setting up' : 'carry on setting up'}
          </button>
        </span>
      </div>
    </div>
  )

  return (
    <>
      {banner}
      {view === 'board' ? (
        <Pipeline ctx={ctx} viewSwitch={viewSwitch} />
      ) : (
        <Jobs ctx={ctx} viewSwitch={viewSwitch} />
      )}
    </>
  )
}
