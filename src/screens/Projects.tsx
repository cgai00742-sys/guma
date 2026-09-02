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
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Jobs from './Jobs'
import Pipeline from './Pipeline'
import type { ShopContext } from '../lib/data'

type View = 'board' | 'list'

export default function Projects({ ctx }: { ctx: ShopContext }) {
  // Kept in the URL as well as in state, so a view can be linked to and
  // survives a reload — the same reason the project page is a page.
  const [params, setParams] = useSearchParams()
  const fromUrl = params.get('view')
  const [view, setView] = useState<View>(fromUrl === 'list' ? 'list' : 'board')

  function choose(next: View) {
    setView(next)
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

  return view === 'board' ? (
    <Pipeline ctx={ctx} viewSwitch={viewSwitch} />
  ) : (
    <Jobs ctx={ctx} viewSwitch={viewSwitch} />
  )
}
