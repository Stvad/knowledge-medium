/**
 * Generates raster PNG icons for the PWA manifest.
 *
 * Pure-Node (no image libs). Renders the same logical design as
 * public/icon.svg by hand-rasterizing primitives (gradient background,
 * rounded rect, circles, lines) to a 32-bit RGBA buffer, then deflates
 * it into a PNG.
 *
 * Run from repo root:  node scripts/gen-icons.mjs
 *
 * Outputs:
 *   public/icon-192.png        — any (rounded corners)
 *   public/icon-512.png        — any (rounded corners)
 *   public/icon-maskable.png   — maskable (full-bleed, centered safe zone)
 *   public/apple-touch-icon.png — 180x180 with rounded corners
 */
import {writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {deflateSync} from 'node:zlib'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const publicDir = resolve(__dirname, '..', 'public')

// CRC32 for PNG chunks (RFC 1952 / ISO 3309 polynomial 0xEDB88320).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const makeChunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

const writePng = (width, height, rgba, outPath) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // Build raw data with per-row filter byte (0 = none).
  const stride = width * 4
  const raw = Buffer.alloc(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    const off = y * (1 + stride)
    raw[off] = 0
    rgba.copy(raw, off + 1, y * stride, (y + 1) * stride)
  }
  const idat = deflateSync(raw, {level: 9})

  const png = Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(outPath, png)
  console.log(`wrote ${outPath} (${png.length} bytes)`)
}

// Shape rasterizers. All work on a Buffer<RGBA, width*height*4> in linear
// (non-premultiplied) sRGB. We do simple alpha-over compositing.
const composite = (dst, x, y, width, r, g, b, a) => {
  const i = (y * width + x) * 4
  const sa = a / 255
  const da = dst[i + 3] / 255
  const outA = sa + da * (1 - sa)
  if (outA <= 0) return
  dst[i] = Math.round((r * sa + dst[i] * da * (1 - sa)) / outA)
  dst[i + 1] = Math.round((g * sa + dst[i + 1] * da * (1 - sa)) / outA)
  dst[i + 2] = Math.round((b * sa + dst[i + 2] * da * (1 - sa)) / outA)
  dst[i + 3] = Math.round(outA * 255)
}

const lerp = (a, b, t) => a + (b - a) * t

const fillGradient = (buf, w, h, c1, c2) => {
  // Linear top-left to bottom-right.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h - 2)
      const i = (y * w + x) * 4
      buf[i] = lerp(c1[0], c2[0], t)
      buf[i + 1] = lerp(c1[1], c2[1], t)
      buf[i + 2] = lerp(c1[2], c2[2], t)
      buf[i + 3] = 255
    }
  }
}

const applyRoundedMask = (buf, w, h, radius) => {
  // Erase corners outside the rounded rectangle (alpha 0).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx = 0, dy = 0
      if (x < radius && y < radius) { dx = radius - x; dy = radius - y }
      else if (x >= w - radius && y < radius) { dx = x - (w - radius - 1); dy = radius - y }
      else if (x < radius && y >= h - radius) { dx = radius - x; dy = y - (h - radius - 1) }
      else if (x >= w - radius && y >= h - radius) { dx = x - (w - radius - 1); dy = y - (h - radius - 1) }
      else continue
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > radius) {
        const i = (y * w + x) * 4
        buf[i + 3] = 0
      } else if (d > radius - 1) {
        const i = (y * w + x) * 4
        buf[i + 3] = Math.round(buf[i + 3] * (radius - d))
      }
    }
  }
}

const drawCircle = (buf, w, h, cx, cy, r, color) => {
  const [cr, cg, cb] = color
  const x0 = Math.max(0, Math.floor(cx - r - 1))
  const x1 = Math.min(w - 1, Math.ceil(cx + r + 1))
  const y0 = Math.max(0, Math.floor(cy - r - 1))
  const y1 = Math.min(h - 1, Math.ceil(cy + r + 1))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
      if (d > r + 0.5) continue
      const a = Math.round(255 * Math.min(1, Math.max(0, r + 0.5 - d)))
      composite(buf, x, y, w, cr, cg, cb, a)
    }
  }
}

const drawLine = (buf, w, h, x0, y0, x1, y1, thickness, color) => {
  const [cr, cg, cb] = color
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - thickness))
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + thickness))
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - thickness))
  const maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + thickness))
  const dx = x1 - x0
  const dy = y1 - y0
  const lenSq = dx * dx + dy * dy
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lenSq))
      const px = x0 + t * dx
      const py = y0 + t * dy
      const d = Math.sqrt((x - px) ** 2 + (y - py) ** 2)
      if (d > thickness + 0.5) continue
      const a = Math.round(255 * Math.min(1, Math.max(0, thickness + 0.5 - d)))
      composite(buf, x, y, w, cr, cg, cb, a)
    }
  }
}

const renderIcon = (size, {maskable = false, rounded = true} = {}) => {
  const buf = Buffer.alloc(size * size * 4)
  // Background gradient.
  fillGradient(buf, size, size, [30, 27, 75], [67, 56, 202])

  // Logical drawing happens in a 512x512 reference space; scale to size.
  // For maskable, content lives in the central 60% safe zone.
  const s = size / 512
  const inset = maskable ? 0.2 * size : 0
  const draw = (cx, cy, fn) => fn(inset + cx * (size - 2 * inset) / 512, inset + cy * (size - 2 * inset) / 512)

  const lineColor = [165, 180, 252]
  const corners = [
    {x: 160, y: 160, fill: [165, 180, 252]},
    {x: 352, y: 160, fill: [199, 210, 254]},
    {x: 160, y: 352, fill: [199, 210, 254]},
    {x: 352, y: 352, fill: [165, 180, 252]},
  ]

  // Lines first (under nodes).
  for (const c of corners) {
    const x0 = inset + c.x * (size - 2 * inset) / 512
    const y0 = inset + c.y * (size - 2 * inset) / 512
    const x1 = inset + 256 * (size - 2 * inset) / 512
    const y1 = inset + 256 * (size - 2 * inset) / 512
    drawLine(buf, size, size, x0, y0, x1, y1, 7 * s * (maskable ? 0.6 : 1), lineColor)
  }

  // Corner nodes.
  for (const c of corners) {
    draw(c.x, c.y, (cx, cy) => drawCircle(buf, size, size, cx, cy, 36 * s * (maskable ? 0.6 : 1), c.fill))
  }

  // Center node (white).
  draw(256, 256, (cx, cy) => drawCircle(buf, size, size, cx, cy, 60 * s * (maskable ? 0.6 : 1), [250, 250, 250]))

  if (rounded && !maskable) applyRoundedMask(buf, size, size, Math.round(96 * s))

  return buf
}

const targets = [
  {name: 'icon-192.png', size: 192, opts: {}},
  {name: 'icon-512.png', size: 512, opts: {}},
  {name: 'icon-maskable.png', size: 512, opts: {maskable: true, rounded: false}},
  {name: 'apple-touch-icon.png', size: 180, opts: {}},
]

for (const t of targets) {
  const rgba = renderIcon(t.size, t.opts)
  writePng(t.size, t.size, rgba, resolve(publicDir, t.name))
}
