/**
 * Quote PDF. Recreated from design/Quote PDF.dc.html with real quote data.
 *
 * `doc-page.js` owns ALL print geometry — paper size, margins, the repeating
 * header and footer, pagination. It is loaded as-is from /doc-page.js and the
 * document is written inside <doc-page>. There is deliberately no @page rule
 * and no print stylesheet anywhere in this app.
 *
 * The quote is priced from its OWN rates_snapshot, never from today's rate
 * card, so reprinting a quote a client already holds can never change a number
 * on it.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { loadQuoteForPrint } from '../lib/data'
import {
  priceQuote,
  ratesFromSnapshot,
  makeMoney,
  trimPct,
  type QuoteInputs,
  type RatesSnapshot,
} from '../lib/pricing'

/** <doc-page> is a custom element defined by doc-page.js. */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'doc-page': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        margin?: string
        size?: string
        orientation?: string
      }
    }
  }
}

const INK = '#16222E'
const INK_DARK = '#0A121C'
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
const shortDate = (iso: string) =>
  new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

/** Container: reads the sent quote by id. */
export default function QuoteDoc() {
  const { quoteId } = useParams()
  const [row, setRow] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!quoteId) return
    loadQuoteForPrint(quoteId)
      .then(setRow)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [quoteId])

  if (error) return <div style={{ padding: 24, fontFamily: 'Inter,sans-serif' }}>{error}</div>
  if (!row) return null
  return <QuoteDocument row={row} />
}

/**
 * The document itself. Pure: give it a quote row (with its jobs / clients /
 * shops joins) and it renders the printable. Kept separate from the container
 * so it can be rendered from a fixture without a network round-trip.
 */
export function QuoteDocument({ row }: { row: any }) {
  useEffect(() => {
    // doc-page.js defines the <doc-page> custom element. Loaded here rather
    // than in index.html so the app shell never pays for it.
    if (!document.querySelector('script[data-doc-page]')) {
      const s = document.createElement('script')
      s.src = '/doc-page.js'
      s.dataset.docPage = 'true'
      document.head.appendChild(s)
    }

    // The quote is single ink on white and is NOT a screen of the app. guma.css
    // is a dark-surface design system: left linked, its `table{width:100%}`,
    // `thead` fill and border colours bleed into the document and it stops
    // looking like the printable in the design package. Suspend it while this
    // route is mounted, and restore it on the way out.
    // `link.disabled = true` is not reliable here, so the element is detached
    // outright and put back on the way out.
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

  const priced = useMemo(() => {
    if (!row?.rates_snapshot) return null
    const snap = row.rates_snapshot as RatesSnapshot
    const { rates, material, printer } = ratesFromSnapshot(snap)
    const input: QuoteInputs = {
      assetOrigin: row.jobs.asset_origin,
      designBilling: row.design_billing === 'flat' ? 'flat' : 'hourly',
      designQty: Number(row.design_qty),
      revisions: row.revisions_incl,
      quantity: row.quantity,
      unitsPerPart: Number(row.units_per_part),
      printHrsPerPart: Number(row.print_hrs_part),
      finishingHrs: Number(row.finishing_hrs),
      rush: row.rush,
      flatEach: Number(row.flat_each),
      discountPct: Number(row.discount_pct),
    }
    return { q: priceQuote(input, rates, material, printer), rates }
  }, [row])

  if (!priced) return null

  const { q, rates } = priced
  // A reprinted quote formats in the currency it was PRICED in, not today's.
  const { money } = makeMoney(rates.currency || 'USD', rates.locale || 'en-US')
  const shop = row.shops
  const job = row.jobs
  const client = job.clients

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
          to="/intake"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 30,
            padding: '0 12px',
            fontSize: 12,
            color: '#16222E',
            background: '#fff',
            border: '1px solid #D6DEE6',
            borderRadius: 6,
            textDecoration: 'none',
          }}
        >
          ← Back to intake
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 30,
            padding: '0 12px',
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            background: '#16222E',
            border: '1px solid #16222E',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Save as PDF
        </button>
      </div>
      <doc-page margin="0.7in">
      {/* ------------------------------------------------- repeating header */}
      <div
        slot="header"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 24,
          paddingBottom: 9,
          borderBottom: `1.5px solid ${INK_DARK}`,
          fontFamily: 'Inter,sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          {/* single ink on light — the correct cut for print */}
          <img src="/brand/guma-mark-ink.svg" alt="" width={30} height={27} style={{ display: 'block' }} />
          <div style={{ fontSize: 15, fontWeight: 650, letterSpacing: '.22em', color: INK_DARK }}>
            {shop.name.toUpperCase()}
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 8.5, lineHeight: 1.5, color: MUTED }}>
          {shop.legal_name} · {shop.address}
          <br />
          {[shop.email, shop.phone, shop.license_no].filter(Boolean).join(' · ')}
        </div>
      </div>

      {/* ------------------------------------------------- repeating footer */}
      <div
        slot="footer"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
          paddingTop: 8,
          borderTop: `1px solid ${RULE}`,
          fontFamily: 'Inter,sans-serif',
          fontSize: 8,
          color: FAINT,
        }}
      >
        <span>
          Quote {job.ref}
          {row.valid_until ? ` · valid until ${longDate(row.valid_until)}` : ''}
        </span>
        <span>
          {shop.legal_name} · {shop.address}
        </span>
      </div>

      {/* --------------------------------------------------------- the body */}
      <div style={{ fontFamily: 'Inter,sans-serif', color: INK }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 32,
            marginBottom: 22,
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 26,
                lineHeight: '31px',
                fontWeight: 650,
                letterSpacing: '-.02em',
                margin: '0 0 5px',
                color: INK_DARK,
              }}
            >
              Quote
            </h1>
            <div style={{ fontSize: 11, color: MUTED }}>{job.title}</div>
          </div>
          <table style={{ borderCollapse: 'collapse', fontSize: 9.5, color: MUTED }}>
            <tbody>
              {(
                [
                  ['Quote no.', job.ref],
                  ['Issued', shortDate((row.sent_at ?? row.created_at).slice(0, 10))],
                  ...(row.valid_until ? [['Valid until', shortDate(row.valid_until)]] : []),
                  ['Turnaround', `${shop.lead_days} business days`],
                ] as [string, string][]
              ).map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding: '1px 0' }}>{k}</td>
                  <td
                    style={{
                      padding: '1px 0 1px 14px',
                      fontFamily: MONO,
                      color: INK,
                      textAlign: 'right',
                    }}
                  >
                    {v}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 26,
            padding: '13px 0',
            borderTop: `1px solid ${RULE}`,
            borderBottom: `1px solid ${RULE}`,
            marginBottom: 22,
            breakInside: 'avoid',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 8,
                textTransform: 'uppercase',
                letterSpacing: '.09em',
                color: FAINT,
                marginBottom: 4,
              }}
            >
              Prepared for
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: INK_DARK }}>{client.name}</div>
            <div style={{ fontSize: 10, lineHeight: 1.55, color: MUTED, marginTop: 2 }}>
              {[client.contact, client.email, client.phone].filter(Boolean).map((s: string, i: number) => (
                <span key={i}>
                  {s}
                  <br />
                </span>
              ))}
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 8,
                textTransform: 'uppercase',
                letterSpacing: '.09em',
                color: FAINT,
                marginBottom: 4,
              }}
            >
              Scope
            </div>
            <div style={{ fontSize: 10, lineHeight: 1.55, color: '#3C4C5C', textWrap: 'pretty' }}>
              {job.brief || job.title}
            </div>
          </div>
        </div>

        {/* Every row shows its arithmetic in the middle column. */}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 4 }}>
          <thead>
            <tr>
              {(['Item', 'Qty · basis', 'Amount'] as const).map((h, i) => (
                <th
                  key={h}
                  style={{
                    textAlign: i === 0 ? 'left' : 'right',
                    fontSize: 8,
                    textTransform: 'uppercase',
                    letterSpacing: '.09em',
                    color: FAINT,
                    fontWeight: 600,
                    padding: i === 0 ? '0 0 7px' : '0 0 7px 12px',
                    whiteSpace: i === 1 ? 'nowrap' : undefined,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.lines.map((l) => (
              <tr key={l.key} style={{ breakInside: 'avoid' }}>
                <td style={{ padding: '9px 0', borderTop: `1px solid ${HAIR}`, verticalAlign: 'top' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: INK_DARK }}>{l.label}</div>
                </td>
                <td
                  style={{
                    padding: '9px 0 9px 12px',
                    borderTop: `1px solid ${HAIR}`,
                    textAlign: 'right',
                    verticalAlign: 'top',
                    fontFamily: MONO,
                    fontSize: 9.5,
                    color: MUTED,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {l.basis}
                </td>
                <td
                  style={{
                    padding: '9px 0 9px 12px',
                    borderTop: `1px solid ${HAIR}`,
                    textAlign: 'right',
                    verticalAlign: 'top',
                    fontFamily: MONO,
                    fontSize: 11,
                    color: INK,
                  }}
                >
                  {money(l.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14, breakInside: 'avoid' }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 270 }}>
            <tbody>
              <tr>
                <td style={{ padding: '4px 0', fontSize: 10, color: MUTED }}>Subtotal</td>
                <td
                  style={{
                    padding: '4px 0 4px 24px',
                    textAlign: 'right',
                    fontFamily: MONO,
                    fontSize: 10.5,
                    color: INK,
                  }}
                >
                  {money(q.subtotal)}
                </td>
              </tr>
              {q.minimumApplied && (
                <tr>
                  <td colSpan={2} style={{ padding: '0 0 4px', fontSize: 8.5, color: FAINT }}>
                    Held at the {money(rates.minimumOrder)} shop minimum.
                  </td>
                </tr>
              )}
              {q.adjustments.map((a) => (
                <tr key={a.key}>
                  <td style={{ padding: '4px 0', fontSize: 10, color: MUTED }}>{a.label}</td>
                  <td
                    style={{
                      padding: '4px 0 4px 24px',
                      textAlign: 'right',
                      fontFamily: MONO,
                      fontSize: 10.5,
                      color: INK,
                    }}
                  >
                    {a.sign === '-' ? '−' : ''}
                    {money(a.amount)}
                  </td>
                </tr>
              ))}
              <tr>
                <td
                  style={{
                    padding: '10px 0 0',
                    borderTop: `1.5px solid ${INK_DARK}`,
                    fontSize: 13,
                    fontWeight: 650,
                    color: INK_DARK,
                  }}
                >
                  Total
                </td>
                <td
                  style={{
                    padding: '10px 0 0 24px',
                    borderTop: `1.5px solid ${INK_DARK}`,
                    textAlign: 'right',
                    fontFamily: MONO,
                    fontSize: 16,
                    fontWeight: 650,
                    color: INK_DARK,
                  }}
                >
                  {money(q.total)}
                </td>
              </tr>
              {q.qty > 1 && (
                <tr>
                  <td style={{ padding: '3px 0 0', fontSize: 9, color: FAINT }}>{money(q.perUnit)} per part</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {q.deposit > 0 && (
          <div
            style={{
              marginTop: 24,
              padding: '14px 16px',
              background: '#F2F6F9',
              borderLeft: `3px solid ${INK_DARK}`,
              breakInside: 'avoid',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 650, color: INK_DARK }}>
                Deposit due before {rates.depositWhen === 'print' ? 'printing' : 'design starts'}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 650, color: INK_DARK }}>
                {money(q.deposit)}
              </div>
            </div>
            <div style={{ fontSize: 9.5, lineHeight: 1.6, color: '#3C4C5C', marginTop: 6, textWrap: 'pretty' }}>
              {trimPct(rates.depositPct)}% of the total.{' '}
              {q.needsDesign
                ? `Modelling begins once it clears; the ${shop.lead_days}-day turnaround is counted from that day, not from today.`
                : 'The job is scheduled onto a machine once it clears.'}{' '}
              Balance of {money(q.balance)} is due on delivery.
            </div>
            {shop.payment_info && (
              <div
                style={{
                  fontSize: 9.5,
                  lineHeight: 1.6,
                  color: '#3C4C5C',
                  marginTop: 7,
                  paddingTop: 7,
                  borderTop: '1px solid #DFE7ED',
                }}
              >
                <b style={{ color: INK_DARK }}>How to pay.</b> {shop.payment_info}
              </div>
            )}
          </div>
        )}

        {shop.revision_policy && q.needsDesign && (
          <div style={{ marginTop: 26, breakInside: 'avoid' }}>
            <div
              style={{
                fontSize: 8,
                textTransform: 'uppercase',
                letterSpacing: '.09em',
                color: FAINT,
                marginBottom: 6,
              }}
            >
              Revisions
            </div>
            <p
              style={{
                fontSize: 9.5,
                lineHeight: 1.65,
                color: '#3C4C5C',
                margin: 0,
                maxWidth: '82ch',
                textWrap: 'pretty',
              }}
            >
              {shop.revision_policy}
            </p>
          </div>
        )}

        {shop.terms_text && (
          <div style={{ marginTop: 20 }}>
            <div
              style={{
                fontSize: 8,
                textTransform: 'uppercase',
                letterSpacing: '.09em',
                color: FAINT,
                marginBottom: 6,
              }}
            >
              Terms
            </div>
            {String(shop.terms_text)
              .split('\n\n')
              .map((para: string, i: number) => (
                <p
                  key={i}
                  style={{
                    fontSize: 9.5,
                    lineHeight: 1.65,
                    color: '#3C4C5C',
                    margin: '0 0 8px',
                    maxWidth: '82ch',
                    textWrap: 'pretty',
                  }}
                >
                  {para}
                </p>
              ))}
            <p
              style={{
                fontSize: 9.5,
                lineHeight: 1.65,
                color: '#3C4C5C',
                margin: 0,
                maxWidth: '82ch',
              }}
            >
              This quote is valid for {shop.quote_valid_days} days.
            </p>
          </div>
        )}

        <div style={{ marginTop: 34, paddingTop: 16, borderTop: `1px solid ${RULE}`, breakInside: 'avoid' }}>
          <div style={{ fontSize: 9.5, color: '#3C4C5C', marginBottom: 20 }}>Accepted for {client.name}:</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr .8fr', gap: 26 }}>
            {['Signature', 'Print name', 'Date'].map((l) => (
              <div
                key={l}
                style={{
                  borderTop: `1px solid ${INK}`,
                  paddingTop: 5,
                  fontSize: 8,
                  textTransform: 'uppercase',
                  letterSpacing: '.09em',
                  color: FAINT,
                }}
              >
                {l}
              </div>
            ))}
          </div>
        </div>
      </div>
      </doc-page>
    </>
  )
}
