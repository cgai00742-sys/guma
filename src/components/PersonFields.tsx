/**
 * Who it went to: a name, and a phone or email if they gave one (CG, 22
 * Nov). Typing a name already on file says so, and the piece joins that
 * person's history -- nobody has to pick from a list or worry about making
 * a second Kai.
 */
import { CLIENT_KINDS, CLIENT_KIND_LABEL, type ClientKind } from '../lib/data.types'
import { findPerson, type PersonInput } from '../lib/people'

export interface KnownPerson {
  id: string
  name: string
  email: string | null
  phone: string | null
  marketingOk?: boolean
}

export const emptyPerson = (kind: ClientKind = 'individual'): PersonInput => ({
  name: '',
  phone: '',
  email: '',
  kind,
  marketingOk: false,
})

export default function PersonFields({
  id,
  value,
  onChange,
  people,
  required = false,
}: {
  id: string
  value: PersonInput
  onChange: (next: PersonInput) => void
  people: KnownPerson[]
  /** A reservation is for someone; a sale or a donation need not say. */
  required?: boolean
}) {
  const set = (p: Partial<PersonInput>) => onChange({ ...value, ...p })
  const known = value.name.trim() ? findPerson(people, value) : null
  const reachable = !!(value.email?.trim() || value.phone?.trim() || known?.email || known?.phone)
  return (
    <div role="group" aria-label="Who it went to">
      <div className="grid3">
        <div className="fld">
          <label className="lbl" htmlFor={`${id}-name`}>
            {required ? 'Reserved for' : 'Name'}
          </label>
          <input
            id={`${id}-name`}
            list={`${id}-people`}
            value={value.name}
            autoComplete="off"
            placeholder={required ? 'Who it is held for' : 'Optional'}
            onChange={(e) => set({ name: e.target.value })}
          />
          <datalist id={`${id}-people`}>
            {people.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`${id}-phone`}>Phone</label>
          <input
            id={`${id}-phone`}
            type="tel"
            value={value.phone ?? ''}
            placeholder={known?.phone ?? 'Optional'}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`${id}-email`}>Email</label>
          <input
            id={`${id}-email`}
            type="email"
            value={value.email ?? ''}
            placeholder={known?.email ?? 'Optional'}
            onChange={(e) => set({ email: e.target.value })}
          />
        </div>
      </div>
      {value.name.trim() && (
        <div className="personline">
          {known ? (
            <span className="hint" style={{ margin: 0 }} data-testid="person-known">
              {known.name} is on file — this goes on their history.
            </span>
          ) : (
            <label className="personkind">
              <span className="hint" style={{ margin: 0 }}>New — they are</span>
              <select
                aria-label="What they are"
                value={value.kind ?? 'individual'}
                onChange={(e) => set({ kind: e.target.value as ClientKind })}
              >
                {CLIENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CLIENT_KIND_LABEL[k] === 'Individual' ? 'a person' : `a ${CLIENT_KIND_LABEL[k].toLowerCase()}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {reachable && !known?.marketingOk && (
            <label className="personconsent">
              <input
                type="checkbox"
                checked={value.marketingOk === true}
                onChange={(e) => set({ marketingOk: e.target.checked })}
              />
              <span>They said yes to hearing about new pieces and offers</span>
            </label>
          )}
        </div>
      )}
    </div>
  )
}

/** Nothing typed: no person to save. */
export const hasPerson = (p: PersonInput) => p.name.trim().length > 0
