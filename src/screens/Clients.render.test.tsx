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
