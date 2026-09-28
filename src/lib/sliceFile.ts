/**
 * Keeping the sliced file itself.
 *
 * sliceImport.ts reads a file and returns what it SAID. This module keeps
 * what it WAS, so that the project can hand the exact file back months
 * later -- which is the only version of "reprint that part" that is not a
 * guess about which copy on which laptop was the one that worked.
 *
 * Gzip, then base64. G-code is text and compresses five to ten times, so
 * the 33% base64 overhead is paid on a much smaller thing; a .gcode.3mf is
 * already a zip and barely moves, which is fine -- it is small to begin
 * with. Both streams are already relied on by the 3MF parser, so this adds
 * no capability the app did not have.
 *
 * THE CAP IS DELIBERATE. A 200 MB G-code would work and should not be
 * allowed to: it goes through the SQL bridge as one JSON string, doubles
 * the database, and buys almost nothing over re-exporting from the slicer.
 * Over the cap the file is simply not kept and the import says so, because
 * a shop that believes it has the file and does not is worse off than one
 * that knows it does not.
 */

/** The largest real file Guma will keep, before compression. */
export const MAX_KEEP_BYTES = 40 * 1024 * 1024

export interface KeptFile {
  /** gzip, then base64. Text, because the SQL bridge moves JSON. */
  content: string
  /** The real file's size, for the sentence the screen prints. */
  byteSize: number
  /** What is actually stored, after gzip and base64. */
  storedSize: number
  encoding: 'gzip-base64'
}

/** Why a file was not kept, in a sentence a person can act on. */
export function tooBigNote(bytes: number): string {
  return `${mb(bytes)} is over the ${mb(MAX_KEEP_BYTES)} limit, so the file itself was not kept — only what it said. Re-export it from the slicer if you need it again.`
}

export function mb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`
}

/**
 * Push bytes through a compression stream and collect what comes out.
 *
 * Written against the TransformStream API alone -- a writer in, a reader
 * out. The obvious version (`new Blob([bytes]).stream().pipeThrough(...)`
 * fed to `new Response(...)`) needs Blob.stream and a streaming Response,
 * and jsdom has neither, so every test of this would have exercised the
 * catch-and-give-up path instead of the real one. That is the worst kind
 * of green test: it proves the fallback works and says nothing about the
 * feature.
 */
async function through(bytes: Uint8Array, stream: TransformStream): Promise<Uint8Array> {
  const writer = (stream.writable as WritableStream<Uint8Array>).getWriter()
  // Deliberately not awaited before reading: gzip of anything larger than
  // one chunk will not resolve the write until the reader drains it, so
  // awaiting here first deadlocks.
  const written = writer.write(bytes).then(() => writer.close())

  const reader = (stream.readable as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  await written

  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** Chunked on purpose: String.fromCharCode(...bytes) on a multi-megabyte
 *  array blows the argument limit and throws, which is a bug that only
 *  appears on big files -- the ones most worth keeping. */
function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Pack a file for storage, or null when it is over the cap or the
 *  platform cannot compress. Never throws: failing to keep a copy must not
 *  fail the import, because the numbers are the part that matters. */
export async function packFile(
  bytes: Uint8Array,
): Promise<KeptFile | null> {
  if (bytes.byteLength > MAX_KEEP_BYTES) return null
  if (typeof CompressionStream === 'undefined') return null
  try {
    const gz = await through(bytes, new CompressionStream('gzip'))
    const content = toBase64(gz)
    return {
      content,
      byteSize: bytes.byteLength,
      storedSize: content.length,
      encoding: 'gzip-base64',
    }
  } catch {
    return null
  }
}

/** The original bytes, back out. */
export async function unpackFile(content: string): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error("This browser can't unpack the stored file.")
  }
  return through(fromBase64(content), new DecompressionStream('gzip'))
}
