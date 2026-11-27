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

export interface Picture {
  src: string
  label: string
}

/**
 * Pictures full size over the page (CG, 27 Nov: "allow the user to see an
 * enlarged view of the pictures"). Arrows or the side buttons step through
 * the plate's pictures; Escape or a click on the backdrop closes it.
 */
export function Gallery({ pictures, start = 0, onClose }: { pictures: Picture[]; start?: number; onClose: () => void }) {
  const [i, setI] = useState(Math.min(start, Math.max(0, pictures.length - 1)))
  const many = pictures.length > 1
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (many && e.key === 'ArrowRight') setI((x) => (x + 1) % pictures.length)
      else if (many && e.key === 'ArrowLeft') setI((x) => (x - 1 + pictures.length) % pictures.length)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose, many, pictures.length])
  const p = pictures[i]
  if (!p) return null
  const step = (d: number) => (e: React.MouseEvent) => {
    e.stopPropagation()
    setI((x) => (x + d + pictures.length) % pictures.length)
  }
  const side = { position: 'absolute', top: '50%', transform: 'translateY(-50%)', fontSize: 28, lineHeight: 1, padding: '10px 14px', background: 'rgba(0,0,0,.5)', color: '#fff', border: '1px solid rgba(255,255,255,.25)', borderRadius: 8, cursor: 'pointer' } as const
  return (
    <div
      role="dialog"
      aria-label={p.label}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.88)', display: 'grid', placeItems: 'center', cursor: 'zoom-out', padding: 24 }}
    >
      <figure style={{ margin: 0, maxWidth: '100%', maxHeight: '100%' }}>
        <img src={p.src} alt={p.label} style={{ maxWidth: '92vw', maxHeight: '84vh', borderRadius: 8, display: 'block', margin: '0 auto' }} onClick={(e) => e.stopPropagation()} />
        <figcaption style={{ color: '#ddd', fontSize: 13, marginTop: 10, textAlign: 'center' }}>
          {p.label}
          {many ? ` · ${i + 1} of ${pictures.length} · ← → to step` : ''} · Esc to close
        </figcaption>
      </figure>
      {many && (
        <>
          <button type="button" aria-label="Previous picture" style={{ ...side, left: 16 }} onClick={step(-1)}>
            ‹
          </button>
          <button type="button" aria-label="Next picture" style={{ ...side, right: 16 }} onClick={step(1)}>
            ›
          </button>
        </>
      )}
    </div>
  )
}

function Enlarged({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  return <Gallery pictures={[{ src, label }]} onClose={onClose} />
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

/** One print on a plate, newest first, and where its photo is kept. */
export interface PlateShot {
  runId: string
  inboxId: string
  /** "2026-11-12", and what came of it, for the caption. */
  date: string | null
  outcome: string | null
}

/**
 * The plate's pictures, side by side at the top of its card (CG, 27 Nov):
 * what the slicer says should be on the bed, and the printer camera's photo
 * of what was -- the last print's, with the rest a click away. Either opens
 * full size, and the arrows step through all of them.
 */
export function PlatePictures({ ctx, preview, fileName, shots }: { ctx: ShopContext; preview: string | null; fileName: string; shots: PlateShot[] }) {
  const [photos, setPhotos] = useState<(Picture | null)[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const key = shots.map((s) => s.inboxId).join(',')
  useEffect(() => {
    let live = true
    setPhotos([])
    if (!shots.length) return
    // One at a time: a plate has a handful, and they are read only here.
    ;(async () => {
      const out: (Picture | null)[] = []
      for (const s of shots) {
        try {
          const p = await inboxPictures(ctx.shop.id, s.inboxId)
          const last = p.photos.find((x) => x.kind === 'camera_last') ?? p.photos[0]
          const when = clock(last?.takenAt ?? null) ?? s.date
          const what = s.outcome && s.outcome !== 'success' ? (s.outcome === 'cancelled' ? ' · stopped part way' : ' · failed') : ''
          out.push(last ? { src: last.data, label: `End of print${when ? ` · ${when}` : ''}${what}` } : null)
        } catch {
          out.push(null)
        }
      }
      if (live) setPhotos(out)
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.shop.id, key])
  const shotsShown = photos.filter((p): p is Picture => !!p)
  const all: Picture[] = [...(preview ? [{ src: preview, label: `The plate, as sliced · ${fileName}` }] : []), ...shotsShown]
  const btn = { padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', position: 'relative', flex: 'none' } as const
  return (
    <div style={{ display: 'flex', gap: 8, flex: 'none' }} data-testid="plate-pictures">
      {preview ? (
        <button type="button" style={btn} onClick={() => setOpen(0)} aria-label="See the plate preview full size" title="What should be on the bed — click to enlarge">
          <img className="platethumb" src={preview} alt={`Preview of ${fileName}`} />
        </button>
      ) : (
        <div className="platethumb none" aria-hidden="true">
          no preview
        </div>
      )}
      {shotsShown.length > 0 && (
        <button
          type="button"
          style={btn}
          onClick={() => setOpen(preview ? 1 : 0)}
          aria-label="See the end-of-print photo full size"
          title={`${shotsShown[0].label} — click to enlarge`}
        >
          <img className="platethumb" src={shotsShown[0].src} alt="The bed at the end of the print" style={{ objectFit: 'cover' }} />
          {shotsShown.length > 1 && (
            <span
              style={{ position: 'absolute', right: 4, bottom: 4, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'rgba(0,0,0,.7)', color: '#fff' }}
            >
              {shotsShown.length} photos
            </span>
          )}
        </button>
      )}
      {open != null && all.length > 0 && <Gallery pictures={all} start={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
