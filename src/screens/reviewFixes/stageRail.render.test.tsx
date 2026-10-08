// @vitest-environment jsdom
/** Repro: the stage rail buttons have no onClick, so "Click to review its
 *  gate" does nothing -- viewPhase can never be set. */
import { beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { holder, moveTo, seed } from './harness'

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => (globalThis as any).__reviewHolder.db } }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
beforeEach(cleanup)

it('clicking a cleared stage on the rail shows that stage’s gate', async () => {
  const { ctx, jobId, data } = await seed()
  await moveTo(data, ctx, jobId, 'design')
  void holder
  const { default: Project } = await import('../Project')
  render(
    <MemoryRouter initialEntries={[`/project/${jobId}`]}>
      <Routes>
        <Route path="/project/:jobId" element={<Project ctx={ctx} />} />
      </Routes>
    </MemoryRouter>,
  )
  await screen.findByText('Mast brackets')
  const intake = screen.getByRole('button', { name: 'Intake' })
  expect(intake.getAttribute('title')).toMatch(/Click to (review its gate|see which)/)
  await userEvent.setup().click(intake)
  // The gate heading should now read "Intake — gate to Client approval".
  expect(document.querySelector('[data-fold="gate"] summary h4')?.textContent).toMatch(/^Intake/)
})
