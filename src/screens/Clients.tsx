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
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CLIENT_KINDS,
  CLIENT_KIND_LABEL,
  listClients,
  listJobs,
  updateClientRecord,
  type ClientKind,
  type ClientRow,
  type JobListRow,
  toRateSet,
  type ShopContext,
} from '../lib/data'
import { PHASE_LABEL, flagsFor } from '../lib/gates'
import { makeMoney } from '../lib/pricing'

type SortKey = 'name' | 'value' | 'owed' | 'active' | 'last'

export default function Clients({ ctx }: { ctx: ShopContext }) {
  const navigate = useNavigate()
  const [rows, setRows] = useState<ClientRow[] | null>(null)
  const [jobs, setJobs] = useState<JobListRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('value')
  const [kindFilter, setKindFilter] = useState<ClientKind | 'all'>('all')
  /** Which client's projects are open. One at a time: this is a table, and
   *  three expanded rows stops being one. */
  const [openId, setOpenId] = useState<string | null>(null)

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
    const list = (rows ?? []).filter((r) => kindFilter === 'all' || r.kind === kindFilter)
    const by: Record<SortKey, (a: ClientRow, b: ClientRow) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      value: (a, b) => b.value - a.value || a.name.localeCompare(b.name),
      owed: (a, b) => b.owed - a.owed || a.name.localeCompare(b.name),
      active: (a, b) => b.active - a.active || a.name.localeCompare(b.name),
      last: (a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''),
    }
    return [...list].sort(by[sort])
  }, [rows, sort, kindFilter])

  const totals = useMemo(() => {
    const list = rows ?? []
    return {
      clients: list.length,
      active: list.reduce((n, r) => n + r.active, 0),
      value: list.reduce((n, r) => n + r.value, 0),
      owed: list.reduce((n, r) => n + r.owed, 0),
    }
  }, [rows])

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

  return (
    <div className="wrap" style={{ paddingTop: 20, paddingBottom: 32 }}>
      <div className="section-head">
        <div>
          <h2>Clients</h2>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--txt-3)', marginTop: 3 }}>
            {rows
              ? `${totals.clients} client${totals.clients === 1 ? '' : 's'} · ${totals.active} active project${totals.active === 1 ? '' : 's'} · ${money(totals.value)} quoted · ${money(totals.owed)} owed`
              : 'Loading…'}
          </div>
        </div>
      </div>

      {error && (
        <div className="alert" style={{ marginBottom: 8 }}>
          <span>{error}</span>
        </div>
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
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      {rows && rows.length === 0 ? (
        <div className="pane">
          <div style={{ fontSize: 12, color: 'var(--txt-2)' }}>
            No clients yet. The first one is created for you the moment you save a project from
            intake — there is no separate "add a client" step to remember.
          </div>
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
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Fragment key={r.id}>
                <tr
                  className="row"
                  title={openId === r.id ? 'Hide their projects' : 'Show their projects'}
                  onClick={() => setOpenId(openId === r.id ? null : r.id)}
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
                  <td className="mono" style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                    {r.lastActivity ? r.lastActivity.slice(0, 10) : 'never'}
                  </td>
                </tr>
                {openId === r.id && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--panel-2)', padding: '10px 14px' }}>
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
        const flags = flagsFor(j.facts)
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
