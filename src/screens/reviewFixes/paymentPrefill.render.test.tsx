// @vitest-environment jsdom
/** Repro: PaymentLog seeds kind/amount from `suggestion` once (useState
 *  initialiser). After the deposit is recorded the form reopens still
 *  offering the same deposit again. */
import { beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { holder, moveTo, seed } from './harness'

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => (globalThis as any).__reviewHolder.db } }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
beforeEach(cleanup)

it('re-opening "Record a payment" after the deposit is paid does not offer the deposit again', async () => {
  const { ctx, jobId, data } = await seed()
  await moveTo(data, ctx, jobId, 'approval')
  holder.db!.sqlite.prepare("update quotes set status = 'sent', deposit_due = 120").run()
  const { default: Project } = await import('../Project')
  render(
    <MemoryRouter initialEntries={[`/project/${jobId}`]}>
      <Routes>
        <Route path="/project/:jobId" element={<Project ctx={ctx} />} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByText('Mast brackets')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /record a payment/i }))
  expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('120.00')
  await user.click(screen.getByRole('button', { name: /^record it$/i }))
  await screen.findByRole('button', { name: /record a payment/i })
  await waitFor(() => expect(document.body.textContent).toMatch(/none required|of 120,00/))
  const d = await data.loadProjectDetail(ctx.shop.id, jobId)
  expect(d.facts.depositOwed).toBe(0)

  await user.click(screen.getByRole('button', { name: /record a payment/i }))
  // Nothing is owed as deposit now -- yet the form offers 120.00 deposit again.
  expect((screen.getByLabelText('What kind') as HTMLSelectElement).value).not.toBe('deposit')
  expect((screen.getByLabelText('Amount') as HTMLInputElement).value).not.toBe('120.00')
})
