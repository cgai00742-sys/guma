/**
 * Project closeout — one page, printable, of what a job was quoted at and
 * what it actually took.
 *
 * Item #2 on Voltage's own upgrade list ("per-project closeout one-pager …
 * quote-vs-actual margin, timeline — doubles as a case study"), and the
 * natural end of the actuals work: every figure it needs already exists,
 * so this is a print view rather than a feature.
 *
 * Two audiences, one page, which is the whole trick:
 *
 *   Inside the shop it is the post-mortem. Where the money went, which line
 *   ran over, and by how much — the conversation that otherwise happens
 *   from memory three jobs later, if at all.
 *
 *   Outside it is a case study. Client, scope, what was made, how long it
 *   took, delivered on this date by this method. The cost columns are the
 *   only part a shop would not hand over, so they sit in one block that is
 *   easy to leave out — and the toolbar can drop it before printing.
 *
 * Print geometry is doc-page.js's, exactly as in QuoteDoc: no @page rule and
 * no print stylesheet anywhere in this app. guma.css is suspended while this
 * route is mounted for the same reason it is there — this is a document on
 * white, not a screen of a dark-surface app.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PHASE_LABEL } from '../lib/gates'
import { buildComparison } from '../lib/actuals'
import {
  PART_STATUS_LABEL,
  loadProjectDetail,
  loadShopContext,
  toRateSet,
  type ProjectDetail,
  type ShopContext,
} from '../lib/data'
import { makeMoney } from '../lib/pricing'
import { todayISO } from '../lib/dates'

const INK = '#16222E'
const MUTED = '#5A6B7C'
const FAINT = '#7189A0'
const RULE = '#D6DEE6'
const HAIR = '#E4EAF0'
const MONO = "'JetBrains Mono',monospace"

const longDate = (iso: string) =>
  new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

export default function Closeout() {
  const { jobId } = useParams()
  const [ctx, setCtx] = useState<ShopContext | null>(null)
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The cost block is the only part of this page a shop would not hand to a
  // client, so it is one toggle rather than a second document to maintain.
  const [showCosts, setShowCosts] = useState(true)

  useEffect(() => {
    if (!jobId) return
    loadShopContext()
      .then(async (c) => {
        setCtx(c)
        setDetail(await loadProjectDetail(c.shop.id, jobId))
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [jobId])

  useEffect(() => {
    if (!document.querySelector('script[data-doc-page]')) {
      const s = document.createElement('script')
      s.src = '/doc-page.js'
      s.dataset.docPage = 'true'
      document.head.appendChild(s)
    }
    const sheets = [
      ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href*="guma.css"]'),
    ].map((l) => ({ el: l, parent: l.parentNode!, next: l.nextSibling }))
    sheets.forEach(({ el }) => el.remove())

    const style = document.createElement('style')
    style.textContent =
      'doc-page:not(:defined){visibility:hidden}body{margin:0;background:#fff}' +
      '@media print{.no-print{display:none !important}}'
    document.head.appendChild(style)
    return () => {
      sheets.forEach(({ el, parent, next }) => parent.insertBefore(el, next))
      style.remove()
    }
  }, [])

  if (error) return <div style={{ padding: 24, fontFamily: 'Inter,sans-serif' }}>{error}</div>
  if (!ctx || !detail) return null

  return (
    <>
      <div
        className="no-print"
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          display: 'flex',
          gap: 8,
          zIndex: 10,
          fontFamily: 'system-ui,-apple-system,sans-serif',
        }}
      >
        <Link
          to={`/project/${detail.jobId}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 30,
            padding: '0 12px',
            fontSize: 12,
            borderRadius: 6,
            border: `1px solid ${RULE}`,
            color: INK,
            background: '#fff',
            textDecoration: 'none',
          }}
        >
          ← Back to the project
        </Link>
        <button
          type="button"
          onClick={() => setShowCosts((v) => !v)}
          style={{
            height: 30,
            padding: '0 12px',
            fontSize: 12,
            borderRadius: 6,
            border: `1px solid ${RULE}`,
            color: INK,
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          {showCosts ? 'Hide costs (client copy)' : 'Show costs'}
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          style={{
            height: 30,
            padding: '0 12px',
            fontSize: 12,
            borderRadius: 6,
            border: `1px solid ${INK}`,
            color: '#fff',
            background: INK,
            cursor: 'pointer',
          }}
        >
          Save as PDF
        </button>
      </div>

      <CloseoutDocument ctx={ctx} detail={detail} showCosts={showCosts} />
    </>
  )
}

/** Pure: give it a shop, a project and a flag, and it renders the page. */
export function CloseoutDocument({
  ctx,
  detail,
  showCosts,
}: {
  ctx: ShopContext
  detail: ProjectDetail
  showCosts: boolean
}) {
  const rates = useMemo(() => toRateSet(ctx.rateCard, ctx.shop), [ctx.rateCard, ctx.shop])
  const { money } = useMemo(() => makeMoney(rates.currency, rates.locale), [rates])
  const comparison = useMemo(
    () =>
      buildComparison(detail, {
        rateCard: ctx.rateCard,
        shop: ctx.shop,
        materials: ctx.materials,
        printers: ctx.printers,
      }),
    [detail, ctx],
  )

  const a = detail.actuals
  const loggedHours = a.designHours + a.finishingHours + a.adminHours
  const delivered = detail.facts.deliveryOn

  return (
    <doc-page size="letter" margin="18mm">
      <header style={{ borderBottom: `2px solid ${INK}`, paddingBottom: 10, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: INK, letterSpacing: '-0.01em' }}>
            {ctx.shop.name}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '0.08em' }}>
            PROJECT CLOSEOUT · {detail.ref}
          </div>
        </div>
      </header>

      <h1 style={{ fontSize: 22, margin: '0 0 4px', color: INK, letterSpacing: '-0.02em' }}>
        {detail.title}
      </h1>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 18 }}>
        {detail.client.name}
        {detail.facts.poc ? ` · ${detail.facts.poc}` : ''} · {PHASE_LABEL[detail.phase]}
        {delivered ? ` · delivered ${longDate(delivered)}` : ' · not yet delivered'}
      </div>

      {detail.brief && (
        <Block title="What they asked for">
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: INK }}>{detail.brief}</p>
        </Block>
      )}

      <Block title="What it took">
        <Grid>
          <Fact label="Machine time" value={`${a.machineHours || 0} h`} sub={`${a.runs} run${a.runs === 1 ? '' : 's'}`} />
          <Fact
            label="Material"
            // The unit comes from the runs that actually happened, not from
            // whichever material happens to be first in the shop's list.
            value={
              a.materialUnits
                ? `${a.materialUnits.toLocaleString()} ${detail.runs.find((r) => r.unit)?.unit ?? 'g'}`
                : '—'
            }
            sub={a.failedUnits > 0 ? `${a.failedUnits.toLocaleString()} into failed runs` : 'no failures'}
          />
          <Fact
            label="Hours worked"
            value={loggedHours ? `${loggedHours} h` : '—'}
            sub={
              loggedHours
                ? [
                    a.designHours ? `${a.designHours} design` : null,
                    a.finishingHours ? `${a.finishingHours} finishing` : null,
                    a.adminHours ? `${a.adminHours} admin` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'none logged'
            }
          />
          <Fact
            label="Handover"
            value={delivered ? longDate(delivered) : 'pending'}
            sub={detail.facts.deliveryHow ?? (detail.facts.neededBy ? `due ${detail.facts.neededBy}` : '—')}
          />
        </Grid>
      </Block>

      {detail.parts.length > 0 && (
        <Block title="What was made">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <Th align="left">Part</Th>
                <Th align="right">Copies</Th>
                <Th align="left">Outcome</Th>
              </tr>
            </thead>
            <tbody>
              {detail.parts.map((p) => {
                const sentBack = p.history.filter((h) => h.toStatus === 'reprint').length
                return (
                  <tr key={p.id}>
                    <Td>{p.label}</Td>
                    <Td align="right" mono>
                      {p.qty}
                    </Td>
                    <Td muted={p.status !== 'passed'}>
                      {p.status === 'passed' ? 'Passed QC' : PART_STATUS_LABEL[p.status]}
                      {sentBack > 0 && (
                        <span style={{ color: MUTED }}>
                          {' '}
                          · reprinted {sentBack} time{sentBack === 1 ? '' : 's'}
                        </span>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {detail.facts.reprintsEver > 0 && (
            <p style={{ fontSize: 10, color: MUTED, marginTop: 6 }}>
              {detail.facts.reprintsEver} reprint
              {detail.facts.reprintsEver === 1 ? '' : 's'} across the build. Each one is material and
              machine time spent twice, and is already counted in the figures below.
            </p>
          )}
        </Block>
      )}

      {showCosts && comparison && (
        <Block title="Quoted against actual">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <Th align="left">Cost</Th>
                <Th align="right">Quoted</Th>
                <Th align="right">Actual</Th>
                <Th align="right">Difference</Th>
              </tr>
            </thead>
            <tbody>
              {comparison.lines.map((l) => (
                <tr key={l.key}>
                  <Td>
                    <div style={{ color: INK }}>{l.label}</div>
                    <div style={{ fontSize: 10, color: FAINT }}>{l.detail}</div>
                  </Td>
                  <Td align="right" mono>
                    {money(l.quoted)}
                  </Td>
                  <Td align="right" mono muted={l.actual === null}>
                    {l.actual === null ? 'not recorded' : money(l.actual)}
                  </Td>
                  <Td align="right" mono>
                    {l.delta === null
                      ? '—'
                      : `${l.delta > 0 ? '+' : ''}${money(l.delta)}${
                          l.pct === null ? '' : ` (${l.pct > 0 ? '+' : ''}${Math.round(l.pct * 100)}%)`
                        }`}
                  </Td>
                </tr>
              ))}
              <tr>
                <Td strong>Total cost</Td>
                <Td align="right" mono strong>
                  {money(comparison.quotedCost)}
                </Td>
                <Td align="right" mono strong>
                  {comparison.actualCost === null ? '—' : money(comparison.actualCost)}
                </Td>
                <Td align="right" mono strong>
                  {comparison.actualCost === null
                    ? '—'
                    : money(comparison.actualCost - comparison.quotedCost)}
                </Td>
              </tr>
            </tbody>
          </table>

          <div
            style={{
              display: 'flex',
              gap: 24,
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${RULE}`,
            }}
          >
            <Fact label="They paid (before tax)" value={money(comparison.netRevenue)} />
            <Fact label="Margin quoted" value={money(comparison.quotedMargin)} />
            <Fact
              label="Margin earned"
              value={comparison.actualMargin === null ? 'not yet' : money(comparison.actualMargin)}
              sub={
                comparison.actualMarginPct === null
                  ? 'nothing recorded'
                  : `${Math.round(comparison.actualMarginPct * 100)}% of what they paid`
              }
            />
          </div>

          {comparison.partial && (
            <p style={{ fontSize: 10, color: MUTED, marginTop: 8 }}>
              Some cost lines have nothing recorded against them, so the margin above is a ceiling
              rather than a figure.
            </p>
          )}
        </Block>
      )}

      {detail.payments.length > 0 && showCosts && (
        <Block title="Paid">
          {detail.payments.map((p) => (
            <Row key={p.id}>
              <span style={{ fontFamily: MONO }}>
                {p.kind === 'refund' ? '−' : ''}
                {money(p.amount)}
              </span>
              <span style={{ color: MUTED }}>
                {p.kind} · {p.method} · {p.receivedOn}
              </span>
            </Row>
          ))}
          <Row>
            <span style={{ fontFamily: MONO, fontWeight: 600 }}>
              {detail.facts.balanceOwed > 0 ? money(detail.facts.balanceOwed) : money(0)}
            </span>
            <span style={{ color: MUTED }}>
              {detail.facts.balanceOwed > 0 ? 'still outstanding' : 'settled in full'}
            </span>
          </Row>
        </Block>
      )}

      {detail.events.length > 0 && (
        <Block title="How it went">
          {detail.events
            .slice()
            .reverse()
            .map((e) => (
              <Row key={e.id}>
                <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT, minWidth: 78 }}>
                  {e.at.slice(0, 10)}
                </span>
                <span style={{ color: INK }}>
                  {e.kind === 'phase_change'
                    ? `${PHASE_LABEL[e.fromPhase ?? 'intake']} → ${PHASE_LABEL[e.toPhase ?? 'intake']}`
                    : (e.body ?? '')}
                </span>
              </Row>
            ))}
        </Block>
      )}

      <footer
        style={{
          marginTop: 22,
          paddingTop: 10,
          borderTop: `1px solid ${HAIR}`,
          fontSize: 10,
          color: FAINT,
        }}
      >
        {ctx.shop.name}
        {ctx.shop.email ? ` · ${ctx.shop.email}` : ''} · closed out{' '}
        {longDate(todayISO())}
      </footer>
    </doc-page>
  )
}

/* ---------------------------------------------------------------- */

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <h2
        style={{
          fontFamily: MONO,
          fontSize: 10,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: FAINT,
          margin: '0 0 8px',
          fontWeight: 500,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16 }}>{children}</div>
  )
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: FAINT, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 15, color: INK, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: MUTED, marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'baseline',
        padding: '4px 0',
        borderBottom: `1px solid ${HAIR}`,
        fontSize: 11,
      }}
    >
      {children}
    </div>
  )
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      style={{
        textAlign: align,
        fontFamily: MONO,
        fontSize: 9,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: FAINT,
        fontWeight: 500,
        padding: '0 0 6px',
        borderBottom: `1px solid ${RULE}`,
      }}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align = 'left',
  mono,
  strong,
  muted,
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
  mono?: boolean
  strong?: boolean
  muted?: boolean
}) {
  return (
    <td
      style={{
        textAlign: align,
        padding: '7px 0',
        borderBottom: `1px solid ${HAIR}`,
        fontFamily: mono ? MONO : undefined,
        fontWeight: strong ? 600 : undefined,
        color: muted ? FAINT : INK,
        verticalAlign: 'top',
      }}
    >
      {children}
    </td>
  )
}
