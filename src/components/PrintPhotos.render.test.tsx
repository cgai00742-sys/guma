// @vitest-environment jsdom
/**
 * A plate's pictures, enlarged (CG, 27 Nov): the slicer's preview and the
 * camera's photo, stepped through with the arrows, closed with Escape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Gallery } from './PrintPhotos'

afterEach(cleanup)

const pics = [
  { src: 'data:image/png;base64,AA==', label: 'The plate, as sliced · plate.bgcode' },
  { src: 'data:image/jpeg;base64,BB==', label: 'End of print · 2026-11-12 19:22' },
]

describe('the enlarged pictures', () => {
  it('opens on the one clicked and steps through the rest', () => {
    const onClose = vi.fn()
    render(<Gallery pictures={pics} start={1} onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: /end of print/i })).toBeTruthy()
    expect(screen.getByText(/2 of 2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /next picture/i }))
    expect(screen.getByRole('dialog', { name: /as sliced/i })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog', { name: /end of print/i })).toBeTruthy()
    // Clicking the picture itself does not close it; the backdrop or Escape does.
    fireEvent.click(screen.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows one picture without arrows', () => {
    render(<Gallery pictures={[pics[1]]} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: /next picture/i })).toBeNull()
    expect(screen.queryByText(/of 1/)).toBeNull()
  })
})
