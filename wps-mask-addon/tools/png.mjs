/*
 * 生成图标用的最小 PNG 工具：解码 RGBA、盒式降采样、再编码。
 * 只处理 8 位非隔行的真彩图（浏览器截图与我们自己的输出都是这一种），够用即止。
 * 不引第三方依赖：Node 自带的 zlib 已经能做 inflate/deflate。
 */
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1 }
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8) }
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

export function decode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) { throw new Error('不是 PNG') }
  let off = 8, width = 0, height = 0, colorType = 0, bitDepth = 0, interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') { idat.push(data) }
    off += len + 12
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error('只支持 8 位非隔行 RGB/RGBA：bitDepth=' + bitDepth + ' colorType=' + colorType)
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    raw.copy(line, 0, pos, pos + stride)
    pos += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) { v += a } else if (filter === 2) { v += b } else if (filter === 3) { v += (a + b) >> 1 } else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      line[x] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const s = x * bpp, d = (y * width + x) * 4
      out[d] = line[s]
      out[d + 1] = line[s + 1]
      out[d + 2] = line[s + 2]
      out[d + 3] = bpp === 4 ? line[s + 3] : 255
    }
    line.copy(prev)
  }
  return { width, height, data: out }
}

// 取居中的正方形。SVG 用 100%/100% 铺满视口并按 viewBox 等比居中，
// 视口不一定是正方形（滚动条会占掉几像素），先取正方形再缩，图标就不会被拉歪。
export function centerSquare(img) {
  const s = Math.min(img.width, img.height)
  const ox = Math.floor((img.width - s) / 2), oy = Math.floor((img.height - s) / 2)
  const out = Buffer.alloc(s * s * 4)
  for (let y = 0; y < s; y++) {
    const from = ((y + oy) * img.width + ox) * 4
    img.data.copy(out, y * s * 4, from, from + s * 4)
  }
  return { width: s, height: s, data: out }
}

// 裁边。无头截图的最右列与最下行会各留 1px 不透明像素（视口边缘的产物），
// 不裁掉的话降采样后就是图标右侧一条竖线、底部一条横线。
export function crop(img, inset) {
  const w = img.width - inset * 2, h = img.height - inset * 2
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = ((y + inset) * img.width + inset) * 4
    img.data.copy(out, y * w * 4, from, from + w * 4)
  }
  return { width: w, height: h, data: out }
}

// 盒式平均。颜色按 alpha 加权，避免透明边缘拉出灰边；不要开 gamma，图标是线稿。
export function resize(img, size) {
  const { width, height, data } = img
  const out = Buffer.alloc(size * size * 4)
  const fx = width / size, fy = height / size
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1 && sy < height; sy++) {
        for (let sx = x0; sx < x1 && sx < width; sx++) {
          const i = (sy * width + sx) * 4
          const al = data[i + 3]
          r += data[i] * al
          g += data[i + 1] * al
          b += data[i + 2] * al
          a += al
          n++
        }
      }
      const d = (y * size + x) * 4
      if (a > 0) {
        out[d] = Math.round(r / a)
        out[d + 1] = Math.round(g / a)
        out[d + 2] = Math.round(b / a)
        out[d + 3] = Math.round(a / n)
      }
    }
  }
  return { width: size, height: size, data: out }
}

export function encode(img) {
  const { width, height, data } = img
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
