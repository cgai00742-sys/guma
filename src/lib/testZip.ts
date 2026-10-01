/** A real stored-entry zip, for tests that need a 3MF. */
export function zipBytes(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  // CRC-32, because a zip without one is not a zip.
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (b: Uint8Array) => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  for (const [path, content] of Object.entries(files)) {
    const nameB = enc.encode(path)
    const data = enc.encode(content)
    const crc = crc32(data)

    const lh = new Uint8Array(30 + nameB.length + data.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 0, true) // stored
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameB.length, true)
    lh.set(nameB, 30)
    lh.set(data, 30 + nameB.length)
    locals.push(lh)

    const ch = new Uint8Array(46 + nameB.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, 0, true) // stored
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameB.length, true)
    cv.setUint32(42, offset, true)
    ch.set(nameB, 46)
    centrals.push(ch)

    offset += lh.length
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const b of [...locals, ...centrals, eocd]) {
    out.set(b, p)
    p += b.length
  }
  return out
}
