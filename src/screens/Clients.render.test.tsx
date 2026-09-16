// @vitest-environment jsdom
/**
 * The Clients screen, rendered.
 *
 * Written straight after the report that made it necessary: "a major
 * concern is that it doesn't allow me to create or delete clients." It
 * did not — a client existed only as a side effect of saving a quote — and
 * nothing in a suite of two hundred tests noticed, because every one of
 * them tested what the code did rather than what a person could do with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { makeCtx } from '../lib/fixtures'
import type { ClientRow } from '../lib/data.types'

const row = (over: Partial<ClientRow> = {}): ClientRow => ({
  id: 'c1',
  name: 'Hafen GmbH',
  kind: 'business',
  contact: 'Ilse Braun',
  email: 'ilse@hafen.de',
  phone: null,
  projects: 0,
  active: 0,
  value: 0,
  owed: 0,
  lastActivity: null,
  ...over,
})

let clients: ClientRow[] = []
const listClients = vi.fn(async () => clients)
const listJobs = vi.fn(async (): Promise<any[]> => [])
const createClient = vi.fn(async (_s: string, _i: any) => 'c-new')
const deleteClient = vi.fn(async (_s: string, _id: string) => {})
const updateClientRecord = vi.fn(async (_s: string, _id: string, _i: any) => {})

vi.mock('../lib/data', async () => {
  const types = await import('../lib/data.types')
  return {
    ...types,
    listClients,
    listJobs,
    createClient,
    deleteClient,
    updateClientRecord,
  }
})

async function renderClients() {
  const { default: Clients } = await import('./Clients')
  render(
    <MemoryRouter>
      <Clients ctx={makeCtx()} />
    </MemoryRouter>,
  )
  await waitFor(() => expect(listClients).toHaveBeenCalled())
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  clients = []
})

describe('with no clients yet', () => {
  it('explains what a client is for instead of showing an empty table', async () => {
    await renderClients()
    expect(await screen.findByText(/no clients yet/i)).toBeDefined()
    expect(screen.getByText(/what they still owe you/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /add your first client/i })).toBeDefined()
  })

  it('does not claim a client can only come from an intake form', async () => {
    // The old copy said there was "no separate add-a-client step to
    // remember", which was true and was the bug.
    await renderClients()
    expect(screen.queryByText(/no separate "add a client" step/i)).toBeNull()
  })
})

describe('adding a client', () => {
  it('needs only a name, and sends what was typed', async () => {
    await renderClients()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add your first client/i }))

    const submit = screen.getByRole('button', { name: /^add client$/i })
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    await user.type(screen.getByLabelText(/^name/i), 'Hafen GmbH')
    await user.type(screen.getByLabelText(/person to deal with/i), 'Ilse Braun')
    expect((screen.getByRole('button', { name: /^add client$/i }) as HTMLButtonElement).disabled).toBe(false)

    await user.click(screen.getByRole('button', { name: /^add client$/i }))
    await waitFor(() => expect(createClient).toHaveBeenCalledTimes(1))
    expect(createClient.mock.calls[0]![1]).toMatchObject({
      name: 'Hafen GmbH',
      contact: 'Ilse Braun',
    })
  })

  it('surfaces the duplicate-name refusal rather than failing silently', async () => {
    createClient.mockRejectedValueOnce(new Error('You already have a client called "Hafen GmbH".'))
    await renderClients()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add your first client/i }))
    await user.type(screen.getByLabelText(/^name/i), 'Hafen GmbH')
    await user.click(screen.getByRole('button', { name: /^add client$/i }))

    expect(await screen.findByText(/already have a client/i)).toBeDefined()
  })
})

describe('editing and deleting', () => {
  it('opens a client’s own details, editable, under their row', async () => {
    clients = [row()]
    await renderClients()
    const user = userEvent.setup()
    await user.click(screen.getByText('Hafen GmbH'))

    const name = (await screen.findByLabelText(/^name$/i)) as HTMLInputElement
    expect(name.value).toBe('Hafen GmbH')

    // Saving is an explicit click, not a blur: this name is what appears on
    // every quote they have ever been sent.
    await user.clear(name)
    await user.type(name, 'Hafen GmbH & Co')
    await user.click(screen.getByRole('button', { name: /save details/i }))
    await waitFor(() => expect(updateClientRecord).toHaveBeenCalledTimes(1))
    expect(updateClientRecord.mock.calls[0]![2]).toMatchObject({ name: 'Hafen GmbH & Co' })
  })

  it('deletes a client with nothing recorded against them, after arming', async () => {
    clients = [row({ projects: 0 })]
    await renderClients()
    const user = userEvent.setup()
    await user.click(screen.getByText('Hafen GmbH'))

    await user.click(screen.getByRole('button', { name: /delete client/i }))
    expect(screen.getByText(/they have no projects/i)).toBeDefined()
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
    await waitFor(() => expect(deleteClient).toHaveBeenCalledWith('shop-1', 'c1'))
  })

  it('warns before the click when the client has projects', async () => {
    clients = [row({ projects: 3 })]
    await renderClients()
    const user = userEvent.setup()
    await user.click(screen.getByText('Hafen GmbH'))
    await user.click(screen.getByRole('button', { name: /delete client/i }))

    // The data layer refuses either way; saying so first saves a round trip
    // and an error message that reads like a fault.
    expect(screen.getByText(/has 3 projects/i)).toBeDefined()
    expect(screen.getByText(/rename instead/i)).toBeDefined()
  })

  it('shows the refusal from the data layer when one comes back', async () => {
    clients = [row({ projects: 2 })]
    deleteClient.mockRejectedValueOnce(
      new Error('Hafen GmbH has 2 projects. Deleting them would take those projects with them.'),
    )
    await renderClients()
    const user = userEvent.setup()
    await user.click(screen.getByText('Hafen GmbH'))
    await user.click(screen.getByRole('button', { name: /delete client/i }))
    await user.click(screen.getByRole('button', { name: /^delete$/i }))

    expect(await screen.findByText(/would take those projects/i)).toBeDefined()
  })
})

describe('finding a client', () => {
  const shop = () => [
    row({ id: 'c1', name: 'Hafen GmbH', contact: 'Ilse Braun', email: 'ilse@hafen.de', phone: '040 555 118' }),
    row({ id: 'c2', name: 'Hafenstadt Schule', kind: 'nonprofit', contact: null, email: null }),
    row({ id: 'c3', name: 'Muñoz Studio', contact: 'Rafa', email: null }),
    row({ id: 'c4', name: 'Tomas Reyes', kind: 'individual', contact: null, email: null }),
  ]

  it('narrows the table as you type, and says how many it is hiding', async () => {
    clients = shop()
    await renderClients()
    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: /find a client/i }), 'hafen')

    expect(screen.getByText('Hafen GmbH')).toBeDefined()
    expect(screen.getByText('Hafenstadt Schule')).toBeDefined()
    expect(screen.queryByText('Tomas Reyes')).toBeNull()
    expect(screen.getByText(/2 clients hidden/i)).toBeDefined()
  })

  it('finds a client by something the table never shows — their phone number', async () => {
    clients = shop()
    await renderClients()
    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: /find a client/i }), '555 118')
    expect(screen.getByText('Hafen GmbH')).toBeDefined()
    expect(screen.queryByText('Tomas Reyes')).toBeNull()
  })

  it('does not care which way round the accent was typed', async () => {
    clients = shop()
    await renderClients()
    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: /find a client/i }), 'munoz')
    expect(screen.getByText('Muñoz Studio')).toBeDefined()
  })

  it('never lets a search look like an empty client list', async () => {
    // The failure this prevents: someone searches a name, sees nothing,
    // concludes the client is not on file, and enters them a second time.
    clients = shop()
    await renderClients()
    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: /find a client/i }), 'zzzz')

    expect(screen.getByText(/nobody matches/i)).toBeDefined()
    expect(screen.getByText(/you have 4 clients on file/i)).toBeDefined()
    expect(screen.queryByText(/no clients yet/i)).toBeNull()

    await user.click(screen.getByRole('button', { name: /show everyone/i }))
    expect(screen.getByText('Tomas Reyes')).toBeDefined()
  })

  it('stays out of the way when there is nobody to search', async () => {
    clients = []
    await renderClients()
    expect(screen.queryByRole('searchbox', { name: /find a client/i })).toBeNull()
  })
})

describe('adding a client is something you can see happen', () => {
  it('names the client it just added, and shows them even mid-search', async () => {
    clients = [row({ id: 'c1', name: 'Hafen GmbH' })]
    await renderClients()
    const user = userEvent.setup()

    // Searching for somebody who is not there yet is exactly when people
    // press Add — so the search must not then hide the result.
    await user.type(screen.getByRole('searchbox', { name: /find a client/i }), 'reyes')
    await user.click(screen.getByRole('button', { name: /add a client/i }))
    await user.type(screen.getByLabelText(/^name/i), 'Tomas Reyes')

    createClient.mockImplementationOnce(async () => {
      clients = [row({ id: 'c1', name: 'Hafen GmbH' }), row({ id: 'c9', name: 'Tomas Reyes' })]
      return 'c9'
    })
    await user.click(screen.getByRole('button', { name: /add client/i }))

    expect(await screen.findByText(/Tomas Reyes added/i)).toBeDefined()
    await waitFor(() => expect(screen.getByText('Tomas Reyes')).toBeDefined())
    expect((screen.getByRole('searchbox', { name: /find a client/i }) as HTMLInputElement).value).toBe('')
  })

  it('shows the button failing rather than a tick, when the name is taken', async () => {
    clients = [row({ id: 'c1', name: 'Hafen GmbH' })]
    await renderClients()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add a client/i }))
    await user.type(screen.getByLabelText(/^name/i), 'hafen gmbh')
    createClient.mockRejectedValueOnce(new Error('You already have a client called Hafen GmbH.'))
    await user.click(screen.getByRole('button', { name: /add client/i }))

    expect(await screen.findByText(/already have a client called/i)).toBeDefined()
    expect(screen.queryByText(/added\.$/i)).toBeNull()
  })

  it('confirms an edit instead of leaving the button looking untouched', async () => {
    clients = [row({ id: 'c1', name: 'Hafen GmbH' })]
    await renderClients()
    const user = userEvent.setup()
    await user.click(screen.getByText('Hafen GmbH'))
    await user.type(screen.getByLabelText(/person to deal with/i), 'Ilse')
    await user.click(screen.getByRole('button', { name: /save details/i }))

    await waitFor(() => expect(updateClientRecord).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: /saved/i })).toBeDefined()
  })
})
