// @vitest-environment jsdom
/**
 * The guidance actually appearing, on the actual screen.
 *
 * guide.test.ts proves the trigger rules. This proves the wiring, which is
 * where the failure everybody has actually experienced lives: a modal that
 * comes back after you dismissed it. The rule is once, ever, and a unit
 * test of a pure function cannot see whether the screen honours it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { makeCtx } from '../lib/fixtures'
import type { JobListRow } from '../lib/data.types'

/** A job list row with only what the guide state reads off it. */
const job = (over: Partial<JobListRow['facts']> = {}): JobListRow =>
  ({
    jobId: 'j1', ref: 'GUMA-2026-0001', title: 'Brackets',
    clientId: 'c1', clientName: 'Hafen GmbH', clientKind: 'business',
    createdAt: '2026-01-01', phase: 'design', priority: 'medium',
    quoteId: 'q1', quoteStatus: 'sent', total: 400, gateAnswers: {},
    facts: {
      kind: 'client', quoteStatus: 'sent', quoteTotal: 400, actualHours: 0,
      actualCost: 0, hasActuals: false, actualRuns: 0, machineHours: 0,
      materialUnits: 0, failedUnits: 0, takenInAt: '2026-01-01',
      balanceOwed: 0, depositDue: 0, depositOwed: 0, parts: 0, partsPrinted: 0,
      partsPassed: 0, partsReprint: 0, reprintsEver: 0, minimumOrder: 0,
      ...over,
    },
  }) as unknown as JobListRow

/**
 * jsdom ships <dialog> without showModal/close, so a dialog never reports
 * itself open and everything inside it stays out of the accessibility tree
 * -- the buttons exist in the DOM and getByRole cannot see them. This is a
 * gap in the test environment, not in the component: the same markup opens
 * correctly in a real browser, which is where the WelcomeModal it copies
 * has been working all along.
 */
function polyfillDialog() {
  const proto = window.HTMLDialogElement?.prototype
  if (!proto) return
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  proto.close = function close(this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
}

let jobs: JobListRow[] = []
let seen: string[] = []
const listJobs = vi.fn(async () => jobs)
const listGuideSeen = vi.fn(async () => seen)
const markGuideSeen = vi.fn(async (_s: string, _c: string) => {})

vi.mock('../lib/data', async () => {
  const types = await import('../lib/data.types')
  return { ...types, listJobs, listGuideSeen, markGuideSeen }
})

async function renderJobs() {
  const { default: Jobs } = await import('./Jobs')
  render(
    <MemoryRouter>
      <Jobs ctx={makeCtx()} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  cleanup()
  polyfillDialog()
  vi.clearAllMocks()
  jobs = [job()]
  seen = []
})

describe('guidance arrives when it is relevant', () => {
  it('explains in-house work to a shop that has jobs and has never logged one', async () => {
    await renderJobs()
    expect(await screen.findByText('Work nobody is paying for')).toBeDefined()
  })

  it('says nothing at all to a shop with an empty board', async () => {
    // The moment somebody knows least about what they need is the worst
    // moment to explain anything to them.
    jobs = []
    await renderJobs()
    await waitFor(() => expect(listGuideSeen).toHaveBeenCalled())
    expect(screen.queryByText('Work nobody is paying for')).toBeNull()
  })

  it('says nothing to a shop already logging in-house work', async () => {
    jobs = [job(), job({ kind: 'inhouse' })]
    await renderJobs()
    await waitFor(() => expect(listGuideSeen).toHaveBeenCalled())
    expect(screen.queryByText('Work nobody is paying for')).toBeNull()
  })

  it('never re-shows a chapter it has already shown', async () => {
    seen = ['in-house']
    await renderJobs()
    await waitFor(() => expect(listGuideSeen).toHaveBeenCalled())
    expect(screen.queryByText('Work nobody is paying for')).toBeNull()
  })
})

describe('dismissing means dismissed', () => {
  it('records the chapter and closes the window', async () => {
    const user = userEvent.setup()
    await renderJobs()
    await screen.findByText('Work nobody is paying for')

    await user.click(screen.getByRole('button', { name: /got it/i }))
    await waitFor(() => expect(markGuideSeen).toHaveBeenCalledWith('shop-1', 'in-house'))
    // Gone from this render, not just marked in a database somewhere: the
    // seen set updates locally before the write lands, so a re-render
    // during the insert cannot bring it back.
    await waitFor(() => expect(screen.queryByText('Work nobody is paying for')).toBeNull())
  })

  it('takes the action and still counts as seen', async () => {
    const user = userEvent.setup()
    await renderJobs()
    await screen.findByText('Work nobody is paying for')

    await user.click(screen.getByRole('button', { name: /start an in-house job/i }))
    await waitFor(() => expect(markGuideSeen).toHaveBeenCalledWith('shop-1', 'in-house'))
  })
})
