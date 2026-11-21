// Draws the app and tray icons (ui/img/*.png) in plain Node: the Hinty mark is four bars (hinty-voice-assistant-s.svg),
// so a few rectangles, 8x supersampled, written with a minimal PNG encoder. No image tool needed.
// Run: node scripts/icons.mjs   (the PNGs are small and kept in git; run again only when the drawing changes)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../ui/img/', import.meta.url))
const BARS = [[0, 4.1, 4.9], [3.9, 0, 9], [7.8, 2.3, 6.7], [11.7, 5.4, 3.6]] // x, y, height in mark units (14 x 9)
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255]

/** shapes: [{ x, y, w, h, c: [r,g,b,a] } | { border, c }] in a 0..1 square, drawn in order */
function draw(size, shapes, bg) {
  const SS = 8, N = size * SS
  const acc = new Float64Array(size * size * 4)
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const u = (px + 0.5) / N, v = (py + 0.5) / N
      let c = bg || [0, 0, 0, 0]
      for (const s of shapes) {
        const inside = s.border
          ? (u >= s.x && u <= s.x + s.w && v >= s.y && v <= s.y + s.h) && !(u >= s.x + s.border && u <= s.x + s.w - s.border && v >= s.y + s.border && v <= s.y + s.h - s.border)
          : u >= s.x && u < s.x + s.w && v >= s.y && v < s.y + s.h
        if (inside) c = s.c
      }
      const i = ((py / SS | 0) * size + (px / SS | 0)) * 4
      // premultiplied accumulation keeps edges clean on transparency
      acc[i] += c[0] * c[3]; acc[i + 1] += c[1] * c[3]; acc[i + 2] += c[2] * c[3]; acc[i + 3] += c[3]
    }
  }
  const px = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3]
    px[i * 4 + 3] = Math.round(a / (SS * SS))
    for (let k = 0; k < 3; k++) px[i * 4 + k] = a ? Math.round(acc[i * 4 + k] / a) : 0
  }
  return png(size, px)
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4) }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** the mark, `scale` = width of the mark as a part of the square, centred (or at `top`) */
const mark = (color, scale, top) => {
  const unit = scale / 14, x0 = (1 - scale) / 2, y0 = top ?? (1 - 9 * unit) / 2
  return BARS.map(([x, y, h]) => ({ x: x0 + x * unit, y: y0 + y * unit, w: 2.2 * unit, h: h * unit, c: hex(color) }))
}
const dot = (color) => ({ x: 0.74, y: 0.04, w: 0.22, h: 0.22, c: hex(color) })

const APP = (size) => draw(size, [{ x: 0.04, y: 0.04, w: 0.92, h: 0.92, border: 0.016, c: hex('#1c1c1c') }, ...mark('#0D80F2', 0.66)], hex('#000000'))
const JOBS = {
  'icon.png': APP(1024),
  'icon-256.png': APP(256),
  'tray.png': draw(16, mark('#a0a0a0', 1, 0.2)),
  'tray@2x.png': draw(32, mark('#a0a0a0', 1, 0.2)),
  'tray-on.png': draw(16, [...mark('#0D80F2', 1, 0.2), dot('#30d158')]),
  'tray-on@2x.png': draw(32, [...mark('#0D80F2', 1, 0.2), dot('#30d158')]),
  'trayTemplate.png': draw(16, mark('#000000', 1, 0.2)),
  'trayTemplate@2x.png': draw(32, mark('#000000', 1, 0.2)),
  'trayOnTemplate.png': draw(16, [...mark('#000000', 1, 0.2), dot('#000000')]),
  'trayOnTemplate@2x.png': draw(32, [...mark('#000000', 1, 0.2), dot('#000000')]),
}
fs.mkdirSync(OUT, { recursive: true })
for (const [name, buf] of Object.entries(JOBS)) { fs.writeFileSync(path.join(OUT, name), buf); console.log(name, buf.length, 'bytes') }
