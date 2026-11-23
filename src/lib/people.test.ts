import { describe, expect, it } from 'vitest'
import { checkInDue, cleanPerson, findPerson } from './people'

const people = [
  { id: 'a', name: 'Kai Akana', email: 'kai@example.com', phone: '(808) 555-0101' },
  { id: 'b', name: 'Kai Lee', email: null, phone: null },
  { id: 'c', name: 'Maui Ocean Center', email: null, phone: '808-555-0199' },
]

describe('finding someone already on file', () => {
  it('by email, whatever the case', () => {
    expect(findPerson(people, { name: 'K', email: 'KAI@example.com ' })?.id).toBe('a')
  })
  it('by phone, however it was typed', () => {
    expect(findPerson(people, { name: 'MOC', phone: '+1 808 555 0199' })?.id).toBe('c')
  })
  it('by the exact name when nothing else is given', () => {
    expect(findPerson(people, { name: '  kai   lee ' })?.id).toBe('b')
  })
  it('not by a name that only starts the same', () => {
    expect(findPerson(people, { name: 'Kai' })).toBeNull()
  })
})

describe('tidying what was typed', () => {
  it('needs a name, and a real-looking email or phone if one is given', () => {
    expect(() => cleanPerson({ name: ' ' })).toThrow(/name/)
    expect(() => cleanPerson({ name: 'Kai', email: 'kai@' })).toThrow(/email/)
    expect(() => cleanPerson({ name: 'Kai', phone: '555' })).toThrow(/phone/)
    expect(cleanPerson({ name: ' Kai  Akana ', email: 'Kai@Example.com' })).toMatchObject({ name: 'Kai Akana', email: 'kai@example.com', marketingOk: false })
  })
})

describe('time to check in', () => {
  const base = { kind: 'sale' as const, client_id: 'a', sold_on: '2026-11-01', followed_up_on: null }
  it('a week to three months after, once', () => {
    expect(checkInDue(base, '2026-11-05')).toBe(false)
    expect(checkInDue(base, '2026-11-08')).toBe(true)
    expect(checkInDue({ ...base, followed_up_on: '2026-11-09' }, '2026-11-10')).toBe(false)
    expect(checkInDue(base, '2027-03-01')).toBe(false)
  })
  it('never for a hold, or for nobody', () => {
    expect(checkInDue({ ...base, kind: 'reserved' }, '2026-11-10')).toBe(false)
    expect(checkInDue({ ...base, client_id: null }, '2026-11-10')).toBe(false)
  })
})
