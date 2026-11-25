/**
 * What a print can be judged by (CG, 25 Nov 2026): the printer camera's
 * photo from the end of the print -- "critical in assuring that the print
 * was successful" and a reminder when the history has not been synced for a
 * while -- and the plate the file says should be on the bed.
 *
 * Pictures are read only when shown: a list of prints never carries them.
 */
import { useEffect, useState } from 'react'
import { inboxPictures, runPhotoRefs } from '../lib/data'
import type { InboxPictures, ShopContext } from '../lib/data.types'

function clock(iso: string | null): string | null {
  if (!iso) return null
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso)
  return m ? `${m[1]} ${m[2]}` : iso
}

function usePictures(ctx: ShopContext, inboxId: string | null, when = true): InboxPictures | null | 'failed' {
  const [pics, setPics] = useState<InboxPictures | null | 'failed'>(null)
  useEffect(() => {
    if (!inboxId || !when) return
    let live = true
    setPics(null)
    Promise.resolve()
      .then(() => inboxPictures(ctx.shop.id, inboxId))
      .then(
        (p) => live && setPics(p),
        () => live && setPics('failed'),
      )
    return () => {
      live = false
    }
  }, [ctx.shop.id, inboxId, when])
  return pics
}

/** A picture full size over the page; a click or Escape closes it. */
function Enlarged({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div
      role="dialog"
      aria-label={label}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.85)', display: 'grid', placeItems: 'center', cursor: 'zoom-out', padding: 24 }}
    >
      <figure style={{ margin: 0, maxWidth: '100%', maxHeight: '100%' }}>
        <img src={src} alt={label} style={{ maxWidth: '92vw', maxHeight: '86vh', borderRadius: 8, display: 'block' }} />
        <figcaption style={{ color: '#ddd', fontSize: 12, marginTop: 8, textAlign: 'center' }}>{label} · click or press Esc to close</figcaption>
      </figure>
    </div>
  )
}

/** The pictures beside a print in Prints to check. */
export function PrintPictures({ ctx, inboxId }: { ctx: ShopContext; inboxId: string }) {
  const pics = usePictures(ctx, inboxId)
  const [big, setBig] = useState<{ src: string; label: string } | null>(null)
  if (pics === null) return <div className="hint" style={{ minHeight: 24 }}>Loading the pictures…</div>
  if (pics === 'failed') return null
  const last = pics.photos.find((p) => p.kind === 'camera_last')
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 }} data-testid="print-pictures">
      {last ? (
        <figure style={{ margin: 0 }}>
          <button
            type="button"
            onClick={() => setBig({ src: last.data, label: `End of print${clock(last.takenAt) ? ` · ${clock(last.takenAt)}` : ''}` })}
            style={{ padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none', cursor: 'zoom-in', display: 'block' }}
            aria-label="See the end-of-print photo full size"
          >
            <img src={last.data} alt="The bed at the end of the print" style={{ width: 360, maxWidth: '100%', display: 'block', borderRadius: 6 }} />
          </button>
          <figcaption className="hint" style={{ marginTop: 4 }}>
            End of print{clock(last.takenAt) ? ` · ${clock(last.takenAt)}` : ''} — click to look closer
          </figcaption>
        </figure>
      ) : (
        <div className="hint" style={{ maxWidth: 260 }}>
          No camera photo from the printer for this one — judge it from the part itself.
        </div>
      )}
      {pics.plate && (
        <figure style={{ margin: 0 }}>
          <button
            type="button"
            onClick={() => setBig({ src: pics.plate!, label: 'The plate, as sliced' })}
            style={{ padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'none', cursor: 'zoom-in', display: 'block' }}
            aria-label="See the plate preview full size"
          >
            <img src={pics.plate} alt="The plate as sliced" style={{ width: 150, display: 'block', borderRadius: 6 }} />
          </button>
          <figcaption className="hint" style={{ marginTop: 4 }}>
            What should be on the bed
          </figcaption>
        </figure>
      )}
      {big && <Enlarged src={big.src} label={big.label} onClose={() => setBig(null)} />}
    </div>
  )
}

/** "photo" on a recorded print: the end-of-print photo it was approved on. */
export function PrintPhotoLink({ ctx, inboxId }: { ctx: ShopContext; inboxId: string }) {
  const [open, setOpen] = useState(false)
  const pics = usePictures(ctx, inboxId, open)
  const last = pics && pics !== 'failed' ? pics.photos.find((p) => p.kind === 'camera_last') ?? pics.photos[0] : null
  return (
    <>
      <button
        type="button"
        className="linkbtn"
        style={{ fontSize: 11, width: 'auto', marginTop: 0 }}
        title="The printer camera's photo from the end of this print"
        onClick={() => setOpen(true)}
      >
        photo
      </button>
      {open && last && <Enlarged src={last.data} label={`End of print${clock(last.takenAt) ? ` · ${clock(last.takenAt)}` : ''}`} onClose={() => setOpen(false)} />}
    </>
  )
}

/** Which prints of a project have a photo: print id -> where it is kept.
 *  Read again when the prints change; nothing on failure. */
export function useRunPhotoRefs(ctx: ShopContext, jobId: string, runsKey: string): Record<string, string> {
  const [refs, setRefs] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => runPhotoRefs(ctx.shop.id, jobId))
      .then(
        (r) => live && setRefs(r && typeof r === 'object' ? r : {}),
        () => {},
      )
    return () => {
      live = false
    }
  }, [ctx.shop.id, jobId, runsKey])
  return refs
}
