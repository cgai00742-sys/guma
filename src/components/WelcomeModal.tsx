/**
 * The first thing a desktop install shows: what Guma is, in plain terms,
 * before anyone's clicked into a screen. Modelled on the "here's what this
 * program is for" splash a downloaded app like Blender opens with, not on
 * a guided product tour -- there's nothing to click through, just three
 * sentences and a way to turn it off.
 *
 * Uses the native <dialog> + .vmui-dlg styling already defined in guma.css
 * (section 4.4) for the pipeline board's project detail dialog, which
 * hasn't shipped yet -- this is the first screen to actually use it.
 *
 * Shown on every launch by default, same as Blender's splash, until
 * "Don't show this again" is checked. Unchecked, closing it only hides it
 * for this session; nothing is written to the database, so it comes back
 * next launch. The flag it writes lives on the one shop row this install
 * has (see 0002_show_welcome.sql) -- there's no separate settings table.
 */
import { useEffect, useRef, useState } from 'react'
import { dismissWelcome } from '../lib/data'
import type { Shop } from '../lib/data.types'

const POINTS: { title: string; body: string }[] = [
  {
    title: 'Price a project honestly',
    body: 'Material, machine time and wear, your own labour, real electricity cost if you’ve set a rate — one total, not a guess.',
  },
  {
    title: 'Quotes that hold still',
    body: 'Every rate change is versioned. A quote a client already holds never moves because you updated a price last week.',
  },
  {
    title: 'One place for the paperwork',
    body: 'Clients, project history, and the quote you sent them — not scattered across a spreadsheet and a text thread.',
  },
]

export default function WelcomeModal({
  shop,
  onDismissedForever,
}: {
  shop: Shop
  onDismissedForever: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (shop.show_welcome) ref.current?.showModal()
  }, [shop.show_welcome])

  async function close() {
    if (!dontShowAgain) {
      ref.current?.close()
      return
    }
    setSaving(true)
    try {
      await dismissWelcome(shop.id)
      ref.current?.close()
      onDismissedForever()
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog ref={ref}>
      <div className="dlg-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/brand/guma-mark.svg" alt="" width={22} height={20} style={{ display: 'block' }} />
          <h3 style={{ margin: 0 }}>Welcome to Guma</h3>
        </div>
      </div>
      <div className="dlg-body">
        <p style={{ fontSize: 12.5, lineHeight: '19px', color: 'var(--txt-2)', margin: '0 0 16px' }}>
          Guma isn’t here to run your printers — OctoPrint, Klipper and the rest already do that.
          It’s the money layer around the printing: what to charge, what a project actually costs you,
          and keeping the paperwork straight once a client says yes.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {POINTS.map((p) => (
            <div key={p.title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--biolum)',
                  marginTop: 6,
                  flex: 'none',
                }}
              />
              <span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', display: 'block' }}>
                  {p.title}
                </span>
                <span style={{ fontSize: 11.5, lineHeight: '17px', color: 'var(--txt-3)' }}>{p.body}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="dlg-foot" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            style={{ width: 'auto' }}
          />
          <span style={{ fontSize: 11.5, color: 'var(--txt-3)' }}>Don’t show this again</span>
        </label>
        <button type="button" className="btn primary" onClick={close} disabled={saving}>
          {saving ? 'Saving…' : 'Get started'}
        </button>
      </div>
    </dialog>
  )
}
