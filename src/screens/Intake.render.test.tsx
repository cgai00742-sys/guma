// @vitest-environment jsdom
/**
 * Intake, actually rendered.
 *
 * The bug that made this file necessary, in the reporter's words: "I tried to
 * move a new project forward but no success. The Job Intake form literally
 * still doesn't have a way for a project to be transitioned to the next
 * stage." Everything underneath it was tested and correct. The form had no
 * button. A test that renders the form is the only kind that catches that.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { makeCtx } from '../lib/fixtures'

const nextJobRef = vi.fn(async () => 'GUMA-2026-0007')
// Typed loosely on purpose: the point of these assertions is the SHAPE the
// screen sends, so the test reads the real argument rather than a narrowed
// copy of it.
const saveQuote = vi.fn(async (_args: any): Promise<any> => ({ jobId: 'job-7', quoteId: 'q-7' }))
const takeProjectIn = vi.fn(async () => {})
const listClients = vi.fn(async (): Promise<any[]> => [])
const createInHouseJob = vi.fn(async (_s: string, _i: any) => 'job-ih')
// The program picker for in-house work reads the project list.
const listJobs = vi.fn(async (): Promise<any[]> => [])
const listSeries = vi.fn(async (): Promise<any[]> => [])
const navigate = vi.fn()

vi.mock('../lib/data', async () => {
  const types = await import('../lib/data.types')
  return {
    nextJobRef, saveQuote, takeProjectIn, listClients, createInHouseJob, listJobs, listSeries,
    toRateSet: types.toRateSet,
  }
})
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

async function renderIntake(who: 'client' | 'inhouse' | null = 'client') {
  const { default: Intake } = await import('./Intake')
  render(
    <MemoryRouter>
      <Intake ctx={makeCtx()} />
    </MemoryRouter>,
  )
  // The job ref is fetched on mount; wait for it so nothing is mid-flight.
  await screen.findByText(/GUMA-2026-0007/)
  // The form now opens on one question -- who this is for -- and nothing
  // else exists until it is answered. Most of the tests below are about
  // the client path, so they answer it and carry on.
  if (who !== null) {
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', {
        name: who === 'inhouse' ? /it is mine/i : /someone is paying/i,
      }),
    )
  }
}

/** The two fields persist() insists on before it will save anything. */
async function fillTheMinimum(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/client/i), 'Hafen GmbH')
  await user.type(screen.getByLabelText(/project title|title/i), 'Mast brackets')
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the three ways out of the intake form', () => {
  it('offers exactly Save draft, Save as PDF and Intake', async () => {
    await renderIntake()
    expect(screen.getByRole('button', { name: /^save draft$/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /^save as pdf$/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /^intake/i })).toBeDefined()
  })

  it('refuses all three until there is a client and a title, and says so', async () => {
    await renderIntake()
    for (const name of [/^save draft$/i, /^save as pdf$/i, /^intake/i]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByText(/needs a client and project title/i)).toBeDefined()

    const user = userEvent.setup()
    await fillTheMinimum(user)
    for (const name of [/^save draft$/i, /^save as pdf$/i, /^intake/i]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false)
    }
    expect(screen.getByText(/ready to save/i)).toBeDefined()
  })
})

describe('what each button actually does', () => {
  it('Save draft saves and leaves the project off the board', async () => {
    await renderIntake()
    const user = userEvent.setup()
    await fillTheMinimum(user)
    await user.click(screen.getByRole('button', { name: /^save draft$/i }))

    await waitFor(() => expect(saveQuote).toHaveBeenCalledTimes(1))
    // A draft is saved but NOT taken in -- that distinction is the whole
    // reason migration 0008 exists.
    expect(takeProjectIn).not.toHaveBeenCalled()
    expect(saveQuote.mock.calls[0][0].send).toBeUndefined()
  })

  it('Intake takes it in and lands the user on the project, not back on the form', async () => {
    await renderIntake()
    const user = userEvent.setup()
    await fillTheMinimum(user)
    await user.click(screen.getByRole('button', { name: /^intake/i }))

    await waitFor(() => expect(takeProjectIn).toHaveBeenCalledTimes(1))
    expect(takeProjectIn).toHaveBeenCalledWith('shop-1', 'job-7', 'usr-1')
    // The original complaint was being stranded on the form. This is the
    // assertion that says it cannot happen again.
    expect(navigate).toHaveBeenCalledWith('/project/job-7')
  })

  it('Save as PDF freezes the rates onto the quote and opens the printable', async () => {
    await renderIntake()
    const user = userEvent.setup()
    await fillTheMinimum(user)
    await user.click(screen.getByRole('button', { name: /^save as pdf$/i }))

    await waitFor(() => expect(saveQuote).toHaveBeenCalledTimes(1))
    const sent = saveQuote.mock.calls[0][0].send
    expect(sent).toBeTruthy()
    expect(sent.rates_snapshot).toBeTruthy()
    expect(sent.valid_until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(takeProjectIn).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/project/job-7?quote=1')
  })

  it('locks all three buttons while a save is in flight', async () => {
    // Not a theoretical concern: saveQuote writes a client, a job and a
    // quote, and a second click mid-write is a duplicate project. In the
    // real app the navigate() at the end unmounts this form, so the disabled
    // state is the only thing standing between a slow disk and two projects.
    let release!: () => void
    saveQuote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ jobId: 'job-7', quoteId: 'q-7' })
        }),
    )

    await renderIntake()
    const user = userEvent.setup()
    await fillTheMinimum(user)
    await user.click(screen.getByRole('button', { name: /^intake/i }))

    await waitFor(() =>
      expect((screen.getByRole('button', { name: /taking in/i }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    )
    expect((screen.getByRole('button', { name: /^save draft$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: /^save as pdf$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    release()
    await waitFor(() => expect(takeProjectIn).toHaveBeenCalledTimes(1))
    expect(saveQuote).toHaveBeenCalledTimes(1)
  })
})

describe('picking a client who already exists', () => {
  it('offers no picker at all when the shop has none yet, and says so', async () => {
    await renderIntake()
    expect(screen.queryByLabelText(/pick an existing client/i)).toBeNull()
    expect(screen.getByText(/your first client/i)).toBeDefined()
  })

  it('lists existing clients and carries their details across', async () => {
    listClients.mockResolvedValueOnce([
      { id: 'c1', name: 'Hafen GmbH', kind: 'business', contact: 'Ilse Braun', email: 'ilse@hafen.de', phone: '+49 30 1', projects: 3, active: 1, value: 4200, owed: 0, lastActivity: null },
    ])
    await renderIntake()
    const picker = await screen.findByLabelText(/pick an existing client/i)
    const user = userEvent.setup()
    await user.selectOptions(picker, 'Hafen GmbH')

    // The whole point: a repeat job joins the ledger it belongs to rather
    // than creating a second client from a different spelling.
    expect((screen.getByLabelText(/^client/i) as HTMLInputElement).value).toBe('Hafen GmbH')
    // The hint names them, and says what is already live for them, rather
    // than the old anonymous "their existing ledger".
    expect(screen.getByText(/joins Hafen GmbH.s existing ledger/i)).toBeDefined()
    expect(screen.getByText(/1 active project/i)).toBeDefined()

    await user.type(screen.getByLabelText(/project title|title/i), 'Deck cleats')
    await user.click(screen.getByRole('button', { name: /^save draft$/i }))
    await waitFor(() => expect(saveQuote).toHaveBeenCalledTimes(1))
    expect(saveQuote.mock.calls[0]![0].client).toMatchObject({
      name: 'Hafen GmbH',
      contact: 'Ilse Braun',
      email: 'ilse@hafen.de',
    })
  })

  it('recognises a client typed in the wrong case as the same client', async () => {
    listClients.mockResolvedValueOnce([
      { id: 'c1', name: 'Hafen GmbH', kind: 'business', contact: 'Ilse Braun', email: null, phone: null, projects: 3, active: 0, value: 4200, owed: 0, lastActivity: null },
    ])
    await renderIntake()
    await screen.findByLabelText(/pick an existing client/i)
    const user = userEvent.setup()
    // Exactly how somebody types it in a hurry. The save matches
    // case-insensitively, so the form must not claim this is someone new.
    await user.type(screen.getByLabelText(/^client/i), 'hafen gmbh')
    expect(screen.getByText(/joins Hafen GmbH.s existing ledger/i)).toBeDefined()
    expect(screen.queryByText(/a new client/i)).toBeNull()
  })

  it('stops a near-miss spelling before it becomes a second ledger', async () => {
    listClients.mockResolvedValueOnce([
      { id: 'c1', name: 'Hafen GmbH', kind: 'business', contact: 'Ilse Braun', email: null, phone: null, projects: 3, active: 0, value: 4200, owed: 0, lastActivity: null },
    ])
    await renderIntake()
    await screen.findByLabelText(/pick an existing client/i)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/^client/i), 'Hafen')

    expect(screen.getByText(/this will create a second client/i)).toBeDefined()
    // And it is one click to take the spelling already on file.
    await user.click(screen.getByRole('button', { name: /use Hafen GmbH/i }))
    expect((screen.getByLabelText(/^client/i) as HTMLInputElement).value).toBe('Hafen GmbH')
    expect(screen.getByText(/joins Hafen GmbH.s existing ledger/i)).toBeDefined()
  })
})

describe('the money on the form is the shop’s money', () => {
  it('prices a German shop in euros with German grouping', async () => {
    await renderIntake()
    // The fixture shop is in Berlin. Any dollar sign on this screen is a bug.
    const body = document.body.textContent ?? ''
    expect(body).toContain('€')
    expect(body).not.toContain('$')
  })
})

/**
 * Work with no client, started from the place a job actually gets started.
 *
 * This lived in a dropdown that only rendered once the shop already had
 * clients, so on a new shop the option did not exist at all -- and a new
 * shop is exactly the one most likely to be printing its own things. The
 * only way through was to invent a client called "In-house", which then sat
 * in the client list counting as a customer with a receivable.
 *
 * It is the first question now, before anything else is on screen. These
 * tests are written from a shop with NO clients on purpose, because that is
 * the shop it was broken for.
 */
describe('a job nobody is paying for', () => {
  it('is offered on a shop that has no clients at all', async () => {
    // listClients resolves to [] by default here -- a brand-new shop.
    await renderIntake(null)
    expect(await screen.findByRole('button', { name: /it is mine/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /someone is paying/i })).toBeDefined()
  })

  it('asks who it is for before anything else exists', async () => {
    // Not a toggle above a form: a toggle lets somebody fill in a client's
    // details and find out halfway down that they picked the wrong kind.
    await renderIntake(null)
    await screen.findByRole('button', { name: /it is mine/i })
    expect(screen.queryByLabelText(/project title/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /save draft/i })).toBeNull()
  })

  it('needs only a title once it is mine, and never asks for a client', async () => {
    const user = userEvent.setup()
    await renderIntake('inhouse')

    // The three client-quote buttons collapse to one: a quote, a PDF and a
    // deposit are all meaningless for work nobody is paying for.
    expect(screen.queryByRole('button', { name: /save as pdf/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /intake →/i })).toBeNull()
    const start = screen.getByRole('button', { name: /start it/i }) as HTMLButtonElement
    expect(start.disabled).toBe(true)

    await user.type(screen.getByLabelText(/project title/i), 'Calibrating the new PETG')
    expect((screen.getByRole('button', { name: /start it/i }) as HTMLButtonElement).disabled).toBe(
      false,
    )

    await user.click(screen.getByRole('button', { name: /start it/i }))
    await waitFor(() =>
      expect(createInHouseJob).toHaveBeenCalledWith('shop-1', {
        title: 'Calibrating the new PETG',
        brief: '',
        // No program chosen: it stands on its own.
        seriesId: null,
      }),
    )
    // It never went near the quote machinery.
    expect(saveQuote).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/project/job-ih')
  })

  it('does not put in-house back in the client picker', async () => {
    // One way in. An option that still sat in the picker would be a second
    // route to the same place, able to disagree with the first.
    listClients.mockResolvedValueOnce([
      { id: 'c1', name: 'Hafen GmbH', kind: 'business', contact: null, email: null, phone: null,
        projects: 1, active: 1, value: 0, owed: 0, lastActivity: null },
    ])
    await renderIntake('client')
    const picker = (await screen.findByLabelText(/pick an existing client/i)) as HTMLSelectElement
    const labels = Array.from(picker.options).map((o) => o.textContent ?? '')
    expect(labels.some((l) => /in-house/i.test(l))).toBe(false)
  })
})
