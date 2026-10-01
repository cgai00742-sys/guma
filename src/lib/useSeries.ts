import { useEffect, useState } from 'react'
import * as data from './data'
import type { JobListRow, SeriesRow } from './data.types'
import { pathLabel } from './programs'
import { seriesPath } from './series'

/** Every series in the shop, for labelling project rows. Empty on failure:
 *  a missing label is better than a broken board. */
export function useSeries(shopId: string): SeriesRow[] {
  const [rows, setRows] = useState<SeriesRow[]>([])
  useEffect(() => {
    let live = true
    try {
      void data
        .listSeries(shopId)
        .then((r) => live && setRows(r))
        .catch(() => undefined)
    } catch {
      /* a test double without listSeries */
    }
    return () => {
      live = false
    }
  }, [shopId])
  return rows
}

/** Where a project sits: its series path for the shop's own work, the old
 *  program path otherwise. */
export function whereLabel(rows: JobListRow[], series: SeriesRow[], jobId: string): string | null {
  const r = rows.find((x) => x.jobId === jobId)
  if (r?.facts.seriesId) return seriesPath(series, r.facts.seriesId)
  return pathLabel(rows, jobId)
}
