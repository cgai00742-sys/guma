/**
 * Clients — the client list, with what each one is actually worth.
 *
 * (Voltage calls this screen Partners, because an advanced-manufacturing
 * workspace deals in programme partners. A print farm has clients, so
 * that is what it is called here, all the way down to the column names.)
 *
 * A shop's client list is normally a contacts page: names, emails, done.
 * That is a rolodex, not a business view. Every column here answers a
 * question an owner asks out loud:
 *
 *   Type      — a school, a one-off individual and a government contract
 *               behave differently on deposits, paperwork and how long they
 *               take to pay. Editable inline, because it is the one field
 *               the shop knows and the database cannot infer.
 *   Projects  — how many times they have come back. Repeat business is the
 *               cheapest business there is.
 *   Active    — how much of your capacity they are holding right now.
 *   Quoted    — sent and accepted quotes only. Draft quotes are numbers the
 *               shop typed to itself; counting them is how a pipeline
 *               starts lying to the person running it.
 *   Owed      — the number that decides whether you take the next job from
 *               them before the last one is settled.
 *
 * Everything is derived at read time from jobs, quotes and the job_money
 * view. Nothing here is a stored rollup, so nothing here can go stale.
 *
 * A client used to come into existence ONLY as a side effect of saving a
 * quote. That made this a history of who you had already billed rather than
 * a list of who you work with: you could not enter the people you already
 * know before there was work to enter, could not fix a name typed wrong on
 * the first job, and could not remove one created by a typo. All three are
 * here now. Deleting is deliberately refused for a client with projects —
 * see deleteClient — because the alternative is a cascade that takes real
 * payments with it.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  CLIENT_KINDS,
  CLIENT_KIND_LABEL,
  createClient,
  deleteClient,
  listClients,
  listJobs,
  listClientShelf,
  markCheckedIn,
  setMarketingOk,
  updateClientRecord,
  type ClientEditInput,
  type ClientKind,
  type ClientRow,
  type JobListRow,
  toRateSet,
  type ShopContext,
} from '../lib/data'
import { PHASE_LABEL, flagsFor } from '../lib/gates'
import { makeMoney } from '../lib/pricing'
import { Flash, SaveButton, useFlash, useSaver } from '../components/Saving'
import SearchField from '../components/SearchField'
import { filterBy } from '../lib/search'
import { asSearchItem } from '../lib/searchItems'
import { useRowAnchor } from '../lib/rowAnchor'
import { checkInDue, SALE_KIND_LABEL } from '../lib/people'
import type { ClientShelfRow } from '../lib/data.types'
import { todayISO } from '../lib/dates'

type SortKey = 'name' | 'value' | 'owed' | 'active' | 'last' | 'checkin' | 'shelf'

export default function Clients({ ctx }: { ctx: ShopContext }) {
  const navigate = useNavigate()
  const [rows, setRows] = useState<ClientRow[] | null>(null)
  const [jobs, setJobs] = useState<JobListRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('value')
  const [kindFilter, setKindFilter] = useState<ClientKind | 'all'>('all')
  /** Only people who said yes to hearing from the shop. */
  const [okOnly, setOkOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [flash, setFlash] = useFlash()
  /** Which client's projects are open. One at a time: this is a table, and
   *  three expanded rows stops being one.
   *
   *  Seeded from the URL, so the global search in the top bar can land on a
   *  client with their row already open rather than dropping you on the
   *  list and leaving you to find them again. */
  const [params] = useSearchParams()
  const [openId, setOpenId] = useState<string | null>(params.get('open'))
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  // Opening one client closes another, which changes the height of the list
  // above the row being clicked. Without this the row slides out from under
  // the cursor -- see rowAnchor.ts for why the browser will not do it here.
  const holdRow = useRowAnchor(openId)

  function toggleOpen(id: string, row: Element | null) {
    holdRow(row)
    setOpenId(openId === id ? null : id)
  }

  const rates = useMemo(() => toRateSet(ctx.rateCard, ctx.shop), [ctx.rateCard, ctx.shop])
  const { money } = useMemo(() => makeMoney(rates.currency, rates.locale), [rates])

  useEffect(() => {
    let cancelled = false
    // Both in one pass: the rollups come from listClients, and the projects
    // behind an expanded row come from the same listJobs rows the board and
    // the list already use — so a client's projects can never disagree with
    // how those same projects look anywhere else in the app.
    Promise.all([listClients(ctx.shop.id), listJobs(ctx.shop.id)])
      .then(([c, j]) => {
        if (cancelled) return
        setRows(c)
        setJobs(j)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [ctx.shop.id])

  const shown = useMemo(() => {
    const list = filterBy(
      (rows ?? []).filter((r) => (kindFilter === 'all' || r.kind === kindFilter) && (!okOnly || r.marketingOk)),
      query,
      asSearchItem.client,
    )
    const by: Record<SortKey, (a: ClientRow, b: ClientRow) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      value: (a, b) => b.value - a.value || a.name.localeCompare(b.name),
      owed: (a, b) => b.owed - a.owed || a.name.localeCompare(b.name),
      active: (a, b) => b.active - a.active || a.name.localeCompare(b.name),
      last: (a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''),
      checkin: (a, b) => (b.checkIns ?? 0) - (a.checkIns ?? 0) || a.name.localeCompare(b.name),
      shelf: (a, b) => (b.shelfPieces ?? 0) - (a.shelfPieces ?? 0) || a.name.localeCompare(b.name),
    }
    return [...list].sort(by[sort])
  }, [rows, sort, kindFilter, query, okOnly])

  const totals = useMemo(() => {
    const list = rows ?? []
    return {
      clients: list.length,
      active: list.reduce((n, r) => n + r.active, 0),
      value: list.reduce((n, r) => n + r.value, 0),
      owed: list.reduce((n, r) => n + r.owed, 0),
      checkIns: list.reduce((n, r) => n + (r.checkIns ?? 0), 0),
    }
  }, [rows])

  /** Everyone shown who said yes and has an email, ready to paste into Bcc
   *  or a mailing tool. Only those who said yes: that is the law, and the
   *  kind of shop people want to hear from. */
  const okEmails = shown.filter((r) => r.marketingOk && r.email).map((r) => r.email as string)
  async function copyEmails() {
    try {
      await navigator.clipboard.writeText(okEmails.join(', '))
      setFlash(`${okEmails.length} email${okEmails.length === 1 ? '' : 's'} copied — paste them into Bcc.`)
    } catch {
      setError('Could not reach the clipboard. ' + okEmails.join(', '))
    }
  }

  async function reload() {
    const [c, j] = await Promise.all([listClients(ctx.shop.id), listJobs(ctx.shop.id)])
    setRows(c)
    setJobs(j)
  }

  async function setKind(row: ClientRow, kind: ClientKind) {
    const prior = rows
    setRows((rs) => (rs ?? []).map((r) => (r.id === row.id ? { ...r, kind } : r)))
    try {
      await updateClientRecord(ctx.shop.id, row.id, { kind })
    } catch (e) {
      setRows(prior)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function addClient(input: ClientEditInput) {
    setBusy(true)
    setError(null)
    try {
      const id = await createClient(ctx.shop.id, input)
      await reload()
      setAdding(false)
      // Three things at once, and all three are the point. Clear whatever
      // is being searched for, or the client you just added may not match
      // it and will appear not to have been added at all. Open their row,
      // because looking at them is what anyone does next. And say their
      // name back, because "did that work?" should not be a question you
      // have to answer by scrolling.
      setQuery('')
      setOpenId(id)
      setFlash(`${(input.name ?? '').trim()} added.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Rethrown so the button that was pressed knows it failed and says
      // so, instead of flashing "Added" over the top of an error message.
      throw e
    } finally {
      setBusy(false)
    }
  }

  async function saveDetails(id: string, input: ClientEditInput) {
    setBusy(true)
    setError(null)
    try {
      await updateClientRecord(ctx.shop.id, id, input)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setBusy(false)
    }
  }

  async function removeClient(id: string) {
    setBusy(true)
    setError(null)
    try {
      const gone = (rows ?? []).find((r) => r.id === id)
      await deleteClient(ctx.shop.id, id)
      setOpenId(null)
      await reload()
      setFlash(`${gone?.name ?? 'That client'} deleted.`)
    } catch (e) {
      // The refusal from deleteClient is the message worth reading — it
      // names how many projects are in the way and what to do instead.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 32 }}>
      <div className="section-head">
        <div>
          <h2>Clients</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            {rows
              ? `${totals.clients} client${totals.clients === 1 ? '' : 's'} · ${totals.active} active project${totals.active === 1 ? '' : 's'} · ${money(totals.value)} quoted · ${money(totals.owed)} owed` +
                (totals.checkIns ? ` · ${totals.checkIns} to check in with` : '')
              : 'Loading…'}
          </div>
        </div>
        <button
          type="button"
          className="btn primary"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? 'Cancel' : 'Add a client'}
        </button>
      </div>

      {adding && <NewClient busy={busy} onAdd={addClient} onCancel={() => setAdding(false)} />}

      <Flash message={flash} />

      {error && (
        <div className="alert" style={{ marginBottom: 8 }}>
          <span>{error}</span>
        </div>
      )}

      {(rows?.length ?? 0) > 0 && (
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Find a client by name, contact, email or phone"
          hidden={(rows?.length ?? 0) - shown.length}
          noun="client"
        />
      )}

      <div className="filters" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
          <span style={{ color: 'var(--txt-3)' }}>Type</span>
          <select
            value={kindFilter}
            style={{ width: 'auto' }}
            onChange={(e) => setKindFilter(e.target.value as ClientKind | 'all')}
          >
            <option value="all">All</option>
            {CLIENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {CLIENT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
          <span style={{ color: 'var(--txt-3)' }}>Sort by</span>
          <select
            value={sort}
            style={{ width: 'auto' }}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="value">Value quoted</option>
            <option value="owed">Owed</option>
            <option value="active">Active projects</option>
            <option value="last">Recent activity</option>
            <option value="checkin">Time to check in</option>
            <option value="shelf">Shelf pieces</option>
            <option value="name">Name</option>
          </select>
        </label>
        <label className="personconsent" style={{ fontSize: 11 }}>
          <input type="checkbox" checked={okOnly} onChange={(e) => setOkOnly(e.target.checked)} />
          <span>Said yes to news</span>
        </label>
        {okOnly && okEmails.length > 0 && (
          <button type="button" className="btn sm" onClick={() => void copyEmails()}>
            Copy {okEmails.length} email{okEmails.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {rows && rows.length > 0 && shown.length === 0 ? (
        <div className="pane">
          <h3>Nobody matches “{query}”</h3>
          <p style={{ fontSize: 13, color: 'var(--txt-2)', margin: '0 0 12px' }}>
            {kindFilter === 'all'
              ? 'You have ' + rows.length + ' client' + (rows.length === 1 ? '' : 's') + ' on file, none of them matching that.'
              : 'No ' + CLIENT_KIND_LABEL[kindFilter].toLowerCase() + ' matches that. Try Type: All.'}
          </p>
          <button type="button" className="btn" onClick={() => setQuery('')}>
            Show everyone
          </button>
        </div>
      ) : rows && rows.length === 0 && !adding ? (
        <div className="pane">
          <h3>No clients yet</h3>
          <p style={{ fontSize: 13, color: 'var(--txt-2)', maxWidth: '62ch', margin: '0 0 10px' }}>
            A client is whoever the work is for — a person, a business, a school. Everything Guma
            knows about money hangs off them: what they have been quoted, what they still owe you,
            how often they come back.
          </p>
          <p style={{ fontSize: 13, color: 'var(--txt-2)', maxWidth: '62ch', margin: '0 0 12px' }}>
            You can add one here, or just start a project — naming a client on the intake form
            creates them. Either way round works.
          </p>
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            Add your first client
          </button>
        </div>
      ) : (
        <div className="pane" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Type</th>
                <th className="r">Projects</th>
                <th className="r">Active</th>
                <th className="r">Quoted</th>
                <th className="r">Owed</th>
                <th className="r" title="Pieces off the Shelf: bought, given or held">Shelf</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Fragment key={r.id}>
                {/* guma.css has carried a `tr.row:focus-visible` rule the
                    whole time, for a state these rows could never reach --
                    a <tr> with an onClick and nothing else is unreachable
                    from the keyboard and announces itself to a screen
                    reader as a plain row of data. The stylesheet was
                    describing a control; now the markup is one. */}
                <tr
                  className="row"
                  tabIndex={0}
                  aria-expanded={openId === r.id}
                  title={openId === r.id ? 'Hide their projects' : 'Show their projects'}
                  onClick={(e) => toggleOpen(r.id, e.currentTarget)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      // Space scrolls the page by default, which on a list
                      // of rows is the opposite of what was asked for.
                      e.preventDefault()
                      toggleOpen(r.id, e.currentTarget)
                    }
                  }}
                >
                  <td>
                    <div style={{ fontWeight: 500, color: 'var(--txt)' }}>
                      <span
                        className="caret"
                        style={{
                          display: 'inline-block',
                          width: 12,
                          color: 'var(--txt-3)',
                          transform: openId === r.id ? 'rotate(90deg)' : undefined,
                        }}
                      >
                        ▸
                      </span>{' '}
                      {r.name}
                      {(r.checkIns ?? 0) > 0 && (
                        <span className="saletag reserved" style={{ marginLeft: 8 }} title="Bought or given a Shelf piece a week to three months ago, and not asked how it is going yet">
                          check in
                        </span>
                      )}
                      {r.marketingOk && (
                        <span className="saletag" style={{ marginLeft: 6 }} title={`Said yes to hearing from you${r.marketingOkOn ? ` on ${r.marketingOkOn}` : ''}`}>
                          news ok
                        </span>
                      )}
                    </div>
                    <div className="pmeta" style={{ paddingLeft: 16 }}>
                      {[r.contact, r.email, r.phone].filter(Boolean).join(' · ') || 'no contact on file'}
                    </div>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      value={r.kind}
                      style={{ width: 'auto', fontSize: 11 }}
                      onChange={(e) => void setKind(r, e.target.value as ClientKind)}
                    >
                      {CLIENT_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {CLIENT_KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="r mono">{r.projects}</td>
                  <td className="r mono" style={{ color: r.active > 0 ? 'var(--ember)' : undefined }}>
                    {r.active}
                  </td>
                  <td className="r mono">{r.value > 0 ? money(r.value) : '—'}</td>
                  <td className="r mono" style={{ color: r.owed > 0 ? 'var(--red)' : undefined }}>
                    {r.owed > 0 ? money(r.owed) : '—'}
                  </td>
                  <td className="r mono">{r.shelfPieces ? r.shelfPieces : '—'}</td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                    {r.lastActivity ? r.lastActivity.slice(0, 10) : 'never'}
                  </td>
                </tr>
                {openId === r.id && (
                  <tr>
                    <td colSpan={8} style={{ background: 'var(--panel-2)', padding: '12px 14px' }}>
                      <ClientDetails
                        key={r.id}
                        client={r}
                        busy={busy}
                        onSave={(input) => saveDetails(r.id, input)}
                        onDelete={() => void removeClient(r.id)}
                      />
                      <ClientShelf
                        ctx={ctx}
                        client={r}
                        money={money}
                        onChanged={() => void reload()}
                        onError={setError}
                      />
                      <ClientProjects
                        projects={jobs.filter((j) => j.clientId === r.id)}
                        money={money}
                        onOpen={(id) => navigate(`/project/${id}`)}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="hint" style={{ marginTop: 10 }}>
        Quoted counts sent and accepted quotes only — a draft is a number you typed to yourself, not
        money anyone has agreed to. Owed is whatever is still outstanding across all of a client's
        projects.
      </div>
    </div>
  )
}

/**
 * One client's projects, opened in place under their row. Deliberately not
 * a second screen: the question this answers — "what is live for them, and
 * what do they owe me" — is the reason someone clicked the row, and making
 * them navigate away from the ledger to find out is how a two-second lookup
 * becomes a four-click errand.
 */
function ClientProjects({
  projects,
  money,
  onOpen,
}: {
  projects: JobListRow[]
  money: (n: number) => string
  onOpen: (jobId: string) => void
}) {
  if (projects.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--txt-3)' }}>
        On file, but nothing has been quoted for them yet.
      </div>
    )
  }
  const ordered = [...projects].sort((a, b) => {
    // Live work first, then most recent — a delivered project from March is
    // never the thing you opened this row to see.
    const live = (j: JobListRow) => (j.phase === 'delivered' ? 1 : 0)
    return live(a) - live(b) || b.createdAt.localeCompare(a.createdAt)
  })
  return (
    <div className="stack" style={{ gap: 6 }}>
      {ordered.map((j) => {
        const flags = flagsFor(j.facts, new Date(), money)
        return (
          <button
            key={j.jobId}
            type="button"
            className="card"
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              flexWrap: 'wrap',
              textAlign: 'left',
              font: 'inherit',
              cursor: 'pointer',
              padding: '8px 10px',
            }}
            onClick={() => onOpen(j.jobId)}
          >
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)' }}>{j.ref}</span>
            <span style={{ fontWeight: 500, color: 'var(--txt)' }}>{j.title}</span>
            <span className="chip">{PHASE_LABEL[j.phase]}</span>
            {flags.map((f) => (
              <span
                key={f.key}
                className={`flagtag ${f.tone}`}
                title={`${f.cause} ${f.action}`}
                style={{
                  color:
                    f.tone === 'crit' ? 'var(--red)' : f.tone === 'warn' ? 'var(--warn)' : 'var(--info)',
                  borderColor: 'currentColor',
                }}
              >
                {f.label}
              </span>
            ))}
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 12 }}>
              {j.total != null ? money(j.total) : '—'}
            </span>
            {j.facts.balanceOwed > 0 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--red)' }}>
                {money(j.facts.balanceOwed)} owed
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Adding a client, before there is any work to hang them on.
 *
 * A name is the only required field, because it is the only one that has to
 * be true to be useful. Everything else is what you happen to know today —
 * demanding an email for someone who only ever phones is how a form teaches
 * people to type "n/a".
 */
function NewClient({
  busy,
  onAdd,
  onCancel,
}: {
  busy: boolean
  onAdd: (input: ClientEditInput) => Promise<void>
  onCancel: () => void
}) {
  const saver = useSaver()
  const [draft, setDraft] = useState<ClientEditInput>({
    name: '',
    kind: 'individual',
    contact: '',
    email: '',
    phone: '',
  })
  const set =
    (k: keyof ClientEditInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setDraft((d) => ({ ...d, [k]: e.target.value }))

  const ready = (draft.name ?? '').trim().length > 0

  return (
    <form
      className="pane"
      style={{ marginBottom: 12 }}
      onSubmit={(e) => {
        e.preventDefault()
        // useSaver catches for us: a rejection becomes a visible failed
        // state on the button, and the screen's alert already carries the
        // message. Nothing escapes for this to have to handle.
        if (ready) void saver.save(() => onAdd(draft))
      }}
    >
      <h3>New client</h3>
      <div className="grid2">
        <div className="fld">
          <label className="lbl" htmlFor="nc-name">
            Name <span style={{ color: 'var(--warn)' }}>*</span>
          </label>
          <input id="nc-name" autoFocus value={draft.name ?? ''} onChange={set('name')} />
          <div className="hint">The name that goes on their quotes.</div>
        </div>
        <div className="fld">
          <label className="lbl" htmlFor="nc-kind">Type</label>
          <select id="nc-kind" value={draft.kind} onChange={set('kind')}>
            {CLIENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {CLIENT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <div className="hint">
            A school, a one-off and a government contract behave differently on deposits and on how
            long they take to pay.
          </div>
        </div>
      </div>
      <div className="grid3" style={{ marginTop: 10 }}>
        <div className="fld">
          <label className="lbl" htmlFor="nc-contact">Person to deal with</label>
          <input id="nc-contact" value={draft.contact ?? ''} onChange={set('contact')} placeholder="optional" />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor="nc-email">Email</label>
          <input id="nc-email" type="email" value={draft.email ?? ''} onChange={set('email')} placeholder="optional" />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor="nc-phone">Phone</label>
          <input id="nc-phone" value={draft.phone ?? ''} onChange={set('phone')} placeholder="optional" />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <SaveButton
          saver={saver}
          savedLabel="Added"
          disabled={!ready || busy}
          onClick={() => void saver.save(() => onAdd(draft))}
        >
          Add client
        </SaveButton>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * A client's own details, edited in place under their row.
 *
 * Saved on an explicit click rather than on blur, unlike the project brief:
 * a name here is a foreign key's worth of identity — it is what appears on
 * every quote they have ever been sent — and changing it by tabbing past a
 * field is not a thing anyone should be able to do by accident.
 *
 * Delete arms in two steps and states what is in the way. For a client with
 * projects the refusal comes from the data layer, not from a disabled
 * button, so the reason travels with it.
 */
function ClientDetails({
  client,
  busy,
  onSave,
  onDelete,
}: {
  client: ClientRow
  busy: boolean
  onSave: (input: ClientEditInput) => Promise<void>
  onDelete: () => void
}) {
  const saver = useSaver()
  const [draft, setDraft] = useState<ClientEditInput>({
    name: client.name,
    contact: client.contact ?? '',
    email: client.email ?? '',
    phone: client.phone ?? '',
  })
  const [armed, setArmed] = useState(false)
  const set = (k: keyof ClientEditInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }))

  const dirty =
    (draft.name ?? '') !== client.name ||
    (draft.contact ?? '') !== (client.contact ?? '') ||
    (draft.email ?? '') !== (client.email ?? '') ||
    (draft.phone ?? '') !== (client.phone ?? '')

  return (
    <div className="pane" style={{ margin: '0 0 12px' }}>
      <h3>Their details</h3>
      <div className="grid2">
        <div className="fld">
          <label className="lbl" htmlFor={`cd-name-${client.id}`}>Name</label>
          <input id={`cd-name-${client.id}`} value={draft.name ?? ''} onChange={set('name')} />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`cd-contact-${client.id}`}>Person to deal with</label>
          <input
            id={`cd-contact-${client.id}`}
            value={draft.contact ?? ''}
            onChange={set('contact')}
            placeholder="optional"
          />
        </div>
      </div>
      <div className="grid2" style={{ marginTop: 10 }}>
        <div className="fld">
          <label className="lbl" htmlFor={`cd-email-${client.id}`}>Email</label>
          <input
            id={`cd-email-${client.id}`}
            type="email"
            value={draft.email ?? ''}
            onChange={set('email')}
            placeholder="optional"
          />
        </div>
        <div className="fld">
          <label className="lbl" htmlFor={`cd-phone-${client.id}`}>Phone</label>
          <input
            id={`cd-phone-${client.id}`}
            value={draft.phone ?? ''}
            onChange={set('phone')}
            placeholder="optional"
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <SaveButton
          saver={saver}
          disabled={!dirty || busy || !(draft.name ?? '').trim()}
          onClick={() => void saver.save(() => onSave(draft))}
        >
          Save details
        </SaveButton>
        <span style={{ marginLeft: 'auto' }} />
        {!armed ? (
          <button
            type="button"
            className="btn ghost"
            style={{ color: 'var(--red)' }}
            disabled={busy}
            onClick={() => setArmed(true)}
          >
            Delete client
          </button>
        ) : (
          <>
            <span style={{ fontSize: 11, color: 'var(--red)', maxWidth: '44ch' }}>
              {client.projects > 0
                ? `${client.name} has ${client.projects} project${client.projects === 1 ? '' : 's'}. Guma will refuse — delete those first, or rename instead.`
                : `Delete ${client.name}? They have no projects, so nothing else goes with them.`}
            </span>
            <button type="button" className="btn sm ghost" onClick={() => setArmed(false)}>
              Keep them
            </button>
            <button type="button" className="btn sm danger" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * What they have had off the Shelf, and the two ways to stay in touch
 * (CG, 22 Nov): asking how a piece is going, and -- only once they have
 * said yes -- telling them about new ones.
 */
function ClientShelf({
  ctx,
  client,
  money,
  onChanged,
  onError,
}: {
  ctx: ShopContext
  client: ClientRow
  money: (n: number) => string
  onChanged: () => void
  onError: (m: string) => void
}) {
  const [rows, setRows] = useState<ClientShelfRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () =>
    listClientShelf(ctx.shop.id, client.id)
      .then(setRows)
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
  useEffect(() => {
    void load()
  }, [client.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn: () => Promise<void>) {
    setBusy(true)
    try {
      await fn()
      await load()
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const today = todayISO()
  const first = client.name.split(' ')[0]
  const reach = client.email || client.phone
  return (
    <div style={{ marginBottom: 12 }} role="region" aria-label="From the Shelf">
      <h3 style={{ marginBottom: 6 }}>From the Shelf</h3>
      {rows === null ? (
        <div className="hint">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="hint" style={{ marginTop: 0 }}>
          Nothing from the Shelf yet. Name them under Donate, Reserve, or Sold on the Shelf and it shows here.
        </div>
      ) : (
        <div className="guide">
          <div className="guide-g">
            <div className="guide-kv">
              {rows.map((r) => {
                const due = checkInDue({ kind: r.kind, client_id: client.id, sold_on: r.soldOn, followed_up_on: r.followedUpOn }, today)
                const subject = encodeURIComponent(`How is your ${r.product}?`)
                const body = encodeURIComponent(`Hi ${first},\n\nJust checking in — how are you enjoying the ${r.product}?\n\n`)
                return (
                  <div className="guide-r" key={r.saleId} style={{ flexWrap: 'wrap' }}>
                    <span className="k">
                      {r.kind !== 'sale' && <span className={`saletag ${r.kind}`}>{SALE_KIND_LABEL[r.kind]}</span>}
                      {r.units} × {r.product}
                      {r.kind === 'sale' ? ` at ${money(r.unitPrice)}` : ''} · {r.soldOn}
                      {r.followedUpOn ? ` · checked in ${r.followedUpOn}` : ''}
                    </span>
                    <span className="v" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {due && client.email && (
                        <a className="btn sm" href={`mailto:${client.email}?subject=${subject}&body=${body}`}>
                          Email them
                        </a>
                      )}
                      {due && client.phone && (
                        <a className="btn sm" href={`sms:${client.phone.replace(/[^\d+]/g, '')}`}>
                          Text them
                        </a>
                      )}
                      {due && (
                        <button type="button" className="btn sm primary" disabled={busy} onClick={() => void act(() => markCheckedIn(ctx.shop.id, r.saleId, today))}>
                          Checked in
                        </button>
                      )}
                      {r.followedUpOn && (
                        <button type="button" className="addnote" disabled={busy} onClick={() => void act(() => markCheckedIn(ctx.shop.id, r.saleId, null))}>
                          undo
                        </button>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
      <label className="personconsent" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={client.marketingOk === true}
          disabled={busy || !reach}
          onChange={(e) => void act(() => setMarketingOk(ctx.shop.id, client.id, e.target.checked))}
        />
        <span>
          {reach
            ? client.marketingOk
              ? `Said yes to hearing about new pieces and offers${client.marketingOkOn ? ` (${client.marketingOkOn})` : ''}. Untick if they ask you to stop.`
              : 'They said yes to hearing about new pieces and offers'
            : 'Add an email or phone below to keep in touch'}
        </span>
      </label>
    </div>
  )
}
