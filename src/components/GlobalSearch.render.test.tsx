// @vitest-environment jsdom
/**
 * The one box that finds anything, rendered.
 *
 * The thing worth testing here is not the matching — search.test.ts does
 * that exhaustively over pure functions. It is the wiring: that all four
 * kinds are actually in the index, that choosing a result goes to the right
 * place, and that "nothing found" is distinguishable from "still loading".
 * Every one of those is a way for a correct matcher to be useless.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { makeCtx } from '../lib/fixtures'
import type { ClientRow, JobListRow, MaterialRow } from '../lib/data.types'

const job = (over: Partial<JobListRow> = {}): JobListRow =>
  ({
    jobId: 'j1',
    ref: 'GUMA-2026-0184',
    title: 'Bracket, revision C',
    clientId: 'c1',
    clientName: 'Hafen GmbH',
    clientKind: 'business',
    createdAt: '2026-09-01T10:00:00.000Z',
    phase: 'building',
    priority: 'normal',
    quoteId: 'q1',
    quoteStatus: 'accepted',
    total: 1205.9,
    facts: { takenInAt: '2026-09-01', balanceOwed: 0, depositOwed: 0, neededBy: null } as any,
    gateAnswers: {},
    ...over,
  }) as JobListRow

const client = (over: Partial<ClientRow> = {}): ClientRow => ({
  id: 'c1',
  name: 'Hafen GmbH',
  kind: 'business',
  contact: 'Ilse Braun',
  email: 'ilse@hafen.de',
  phone: '040 555 118',
  projects: 3,
  active: 1,
  value: 4200,
  owed: 0,
  lastActivity: null,
  ...over,
})

const material = (over: Partial<MaterialRow> = {}): MaterialRow =>
  ({
    id: 'm1',
    name: 'PETG, black',
    kind: 'PETG',
    swatch: '#111',
    unit: 'g',
    costPerUnit: 0.03,
    sellOverride: null,
    onHand: 4000,
    reorderAt: 500,
    archived: false,
    avgCostPerUnit: 0.031,
    costBasis: 'purchases',
    ...over,
  }) as MaterialRow

const listJobs = vi.fn(async () => [job()])
const listClients = vi.fn(async () => [client()])
const listMaterials = vi.fn(async () => [material()])

vi.mock('../lib/data', async () => {
  const types = await import('../lib/data.types')
  return { ...types, listJobs, listClients, listMaterials }
})

/** Where the router ended up, printed on screen so a test can read it. */
function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname + loc.search}</div>
}

async function renderSearch() {
  const { default: GlobalSearch } = await import('./GlobalSearch')
  render(
    <MemoryRouter initialEntries={['/projects']}>
      <GlobalSearch ctx={makeCtx()} />
      <Where />
      <Routes>
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  )
  return userEvent.setup()
}

const box = () => screen.getByRole('searchbox', { name: /search everything/i })

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('what it can find', () => {
  it('finds a project, a client, a machine and a material from the one box', async () => {
    const user = await renderSearch()

    await user.type(box(), 'bracket')
    expect(await screen.findByText(/revision C/)).toBeDefined()

    await user.clear(box())
    await user.type(box(), 'hafen')
    await waitFor(() => expect(screen.getByRole('option', { name: /^Hafen GmbH/ })).toBeDefined())

    await user.clear(box())
    await user.type(box(), 'prusa')
    await waitFor(() => expect(screen.getByRole('option', { name: /^Prusa XL/ })).toBeDefined())

    await user.clear(box())
    await user.type(box(), 'petg')
    await waitFor(() => expect(screen.getByRole('option', { name: /^PETG/ })).toBeDefined())
  })

  it('finds a project by the reference printed on its paperwork', async () => {
    const user = await renderSearch()
    await user.type(box(), '0184')
    expect(await screen.findByText(/revision C/)).toBeDefined()
  })

  it('says nothing matched, rather than showing an empty panel', async () => {
    const user = await renderSearch()
    await user.type(box(), 'zzzz')
    expect(await screen.findByText(/nothing in the shop matches/i)).toBeDefined()
  })

  it('shows no panel at all until something has been typed', async () => {
    const user = await renderSearch()
    await user.click(box())
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('getting there', () => {
  it('opens the project a result names', async () => {
    const user = await renderSearch()
    await user.type(box(), 'bracket')
    await user.click(await screen.findByRole('option', { name: /^Bracket, revision C/ }))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/project/j1'))
  })

  it('lands on a client with their row already open, not just on the list', async () => {
    const user = await renderSearch()
    await user.type(box(), 'hafen gmbh')
    await user.click(await screen.findByRole('option', { name: /^Hafen GmbH/ }))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/clients?open=c1'))
  })

  it('lands on the right settings tab for a machine, not just on settings', async () => {
    const user = await renderSearch()
    await user.type(box(), 'prusa')
    await user.click(await screen.findByRole('option', { name: /^Prusa XL/ }))
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/settings?tab=machines'),
    )
  })

  it('goes where the arrow keys point, on Enter', async () => {
    listJobs.mockResolvedValueOnce([
      job({ jobId: 'j1', title: 'Bracket one' }),
      job({ jobId: 'j2', title: 'Bracket two' }),
    ])
    const user = await renderSearch()
    await user.type(box(), 'bracket')
    await screen.findByRole('option', { name: /^Bracket one/ })
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/project/j2'))
  })

  it('clears itself on the way out, so the next search starts empty', async () => {
    const user = await renderSearch()
    await user.type(box(), 'bracket')
    await user.click(await screen.findByRole('option', { name: /^Bracket, revision C/ }))
    await waitFor(() => expect((box() as HTMLInputElement).value).toBe(''))
  })
})

describe('the keyboard', () => {
  it('opens on Cmd-K from anywhere on the page', async () => {
    const user = await renderSearch()
    // Focus is elsewhere entirely.
    screen.getByTestId('where').focus()
    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => expect(document.activeElement).toBe(box()))
  })

  it('opens on Ctrl-K too, because not every shop is on a Mac', async () => {
    const user = await renderSearch()
    screen.getByTestId('where').focus()
    await user.keyboard('{Control>}k{/Control}')
    await waitFor(() => expect(document.activeElement).toBe(box()))
  })

  it('closes on Escape without navigating anywhere', async () => {
    const user = await renderSearch()
    await user.type(box(), 'bracket')
    await screen.findByRole('option', { name: /^Bracket, revision C/ })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByTestId('where').textContent).toBe('/projects')
  })
})
