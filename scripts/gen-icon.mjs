/**
 * 程序图标生成器（纯 Node，无第三方依赖）。
 *
 * 为什么手写 PNG/ICO 编码：本项目环境没有 rsvg / inkscape / cairosvg / PIL，
 * Windows 也无法用 ImageMagick 的 SVG→PNG。Electron 窗口 / 任务栏 / 打包 exe
 * 图标必须是真实 PNG/ICO，于是用 Node 内置 zlib 直接编码。
 *
 * 设计：圆角方块底（葡萄紫渐变） + 白色 lucide `Sparkles` 图形 —— 与侧栏顶部
 * "GrClean" 左侧的品牌图标完全同源。图形数据硬编码自
 * node_modules/@lucide/vue/dist/esm/icons/sparkles.mjs（v1.48.0）：
 *   - 主星：闭合 SVG path（M/l/a/z，弧做内凹圆角尖）→ 解析扁平化为多边形填充
 *   - 右上小十字：两条 stroke 线（宽 2，round cap）→ 胶囊距离场填充
 *   - 左下圆点：实心圆 r=2
 *
 * 输出（256×256 RGBA，2×2 超采样抗锯齿）：
 *   resources/icon.png   —— 运行时窗口 / 任务栏图标（main/index.ts 引用）
 *   build/icon.png       —— electron-builder 打包图标源
 *   build/icon.ico       —— Windows exe / 桌面快捷方式图标（PNG-in-ICO 封装）
 *
 * 用法：node scripts/gen-icon.mjs
 */
import zlib from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_RUNTIME = resolve(__dirname, '../resources/icon.png')
const OUT_BUILD_PNG = resolve(__dirname, '../build/icon.png')
const OUT_BUILD_ICO = resolve(__dirname, '../build/icon.ico')

const SIZE = 256

// 圆角方块参数
const MARGIN = 16
const RECT_L = MARGIN
const RECT_T = MARGIN
const RECT_R = SIZE - MARGIN
const RECT_B = SIZE - MARGIN
const RADIUS = 46

// 葡萄紫渐变（取自 grape 主题：--primary #8b6fd6 → 加深）
const TOP = [0x8b, 0x6f, 0xd6]
const BOTTOM = [0x5b, 0x40, 0xa0]

// ---------------------------------------------------------------------------
// lucide Sparkles 图形数据（24×24 网格，v1.48.0）
// ---------------------------------------------------------------------------
const SPARK_STAR =
  'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z'
// 右上小十字（stroke-width 2, round cap → 等价胶囊）
const SPARK_CROSS = [
  { x1: 20, y1: 2, x2: 20, y2: 6 },
  { x1: 22, y1: 4, x2: 18, y2: 4 },
]
// 左下圆点
const SPARK_DOT = { cx: 4, cy: 20, r: 2 }

// ---------------------------------------------------------------------------
// 极简 SVG path 解析：支持 M/L/H/V/A/Z 及相对小写（Sparkles 仅用到 M/l/a/z）
// ---------------------------------------------------------------------------

/** 椭圆弧端点参数化 → 中心参数化采样点列（不含起点）。 */
function arcToPoints(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2, seg = 24) {
  if (rx === 0 || ry === 0) return [[x2, y2]]
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const phi = (phiDeg * Math.PI) / 180
  const cosP = Math.cos(phi)
  const sinP = Math.sin(phi)
  const dx2 = (x1 - x2) / 2
  const dy2 = (y1 - y2) / 2
  const x1p = cosP * dx2 + sinP * dy2
  const y1p = -sinP * dx2 + cosP * dy2
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }
  const sign = largeArc !== sweep ? 1 : -1
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const co = sign * Math.sqrt(Math.max(0, num / den))
  const cxp = (co * rx * y1p) / ry
  const cyp = (-co * ry * x1p) / rx
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2

  function ang(ux, uy, vx, vy) {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const theta = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dTheta = ang(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  )
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI

  const pts = []
  for (let i = 1; i <= seg; i++) {
    const t = theta + (dTheta * i) / seg
    pts.push([
      cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP,
      cy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP,
    ])
  }
  return pts
}

/** 把 path 解析为多边形顶点列表（扁平化）。 */
function parsePath(d) {
  const tokens = d.match(/[MmLlHhVvAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []
  let i = 0
  let cmd = ''
  const verts = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  const num = () => parseFloat(tokens[i++])

  while (i < tokens.length) {
    if (/[MmLlHhVvAaZz]/.test(tokens[i])) cmd = tokens[i++]
    switch (cmd) {
      case 'M':
      case 'm': {
        const rel = cmd === 'm'
        const x = num()
        const y = num()
        cx = rel ? cx + x : x
        cy = rel ? cy + y : y
        if (verts.length === 0) {
          sx = cx
          sy = cy
        }
        verts.push([cx, cy])
        // M 后续参数按 L 处理
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L':
      case 'l': {
        const rel = cmd === 'l'
        const x = num()
        const y = num()
        cx = rel ? cx + x : x
        cy = rel ? cy + y : y
        verts.push([cx, cy])
        break
      }
      case 'H':
      case 'h': {
        const rel = cmd === 'h'
        const x = num()
        cx = rel ? cx + x : x
        verts.push([cx, cy])
        break
      }
      case 'V':
      case 'v': {
        const rel = cmd === 'v'
        const y = num()
        cy = rel ? cy + y : y
        verts.push([cx, cy])
        break
      }
      case 'A':
      case 'a': {
        const rel = cmd === 'a'
        const rx = num()
        const ry = num()
        const rot = num()
        const la = num()
        const sw = num()
        const ax = num()
        const ay = num()
        const x2 = rel ? cx + ax : ax
        const y2 = rel ? cy + ay : ay
        verts.push(...arcToPoints(cx, cy, rx, ry, rot, la, sw, x2, y2))
        cx = x2
        cy = y2
        break
      }
      case 'Z':
      case 'z':
        verts.push([sx, sy])
        i++
        break
      default:
        i++
    }
  }
  return verts
}

const STAR_VERTS = parsePath(SPARK_STAR)
const STAR_BBOX = STAR_VERTS.reduce(
  (b, [x, y]) => ({
    x0: Math.min(b.x0, x),
    y0: Math.min(b.y0, y),
    x1: Math.max(b.x1, x),
    y1: Math.max(b.y1, y),
  }),
  { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
)

function pointInPolygon(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** 点到线段距离（胶囊判定用）。 */
function distToSegment(px, py, s) {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - s.x1) * dx + (py - s.y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy))
}

// 24 网格 → 画布映射：图形中心 (12,12) 对齐画布中心
const SCALE = 9.2
const CX = SIZE / 2
const CY = SIZE / 2
const toPx = (x, y) => [CX + (x - 12) * SCALE, CY + (y - 12) * SCALE]

const STAR_PX = STAR_VERTS.map(([x, y]) => toPx(x, y))
const STAR_PX_BBOX = {
  x0: CX + (STAR_BBOX.x0 - 12) * SCALE,
  y0: CY + (STAR_BBOX.y0 - 12) * SCALE,
  x1: CX + (STAR_BBOX.x1 - 12) * SCALE,
  y1: CY + (STAR_BBOX.y1 - 12) * SCALE,
}
const CROSS_PX = SPARK_CROSS.map((s) => {
  const [ax, ay] = toPx(s.x1, s.y1)
  const [bx, by] = toPx(s.x2, s.y2)
  return { x1: ax, y1: ay, x2: bx, y2: by }
})
const CROSS_R = (2 / 2) * SCALE // stroke-width 2 的一半
const DOT_PX = toPx(SPARK_DOT.cx, SPARK_DOT.cy)
const DOT_R = SPARK_DOT.r * SCALE

function pointInSparkle(px, py) {
  if (
    px >= STAR_PX_BBOX.x0 &&
    px <= STAR_PX_BBOX.x1 &&
    py >= STAR_PX_BBOX.y0 &&
    py <= STAR_PX_BBOX.y1 &&
    pointInPolygon(px, py, STAR_PX)
  ) {
    return true
  }
  for (const s of CROSS_PX) {
    if (distToSegment(px, py, s) <= CROSS_R) return true
  }
  return Math.hypot(px - DOT_PX[0], py - DOT_PX[1]) <= DOT_R
}

function pointInRoundedRect(x, y) {
  if (x < RECT_L || x > RECT_R || y < RECT_T || y > RECT_B) return false
  const inCornerX = x < RECT_L + RADIUS || x > RECT_R - RADIUS
  const inCornerY = y < RECT_T + RADIUS || y > RECT_B - RADIUS
  if (!(inCornerX && inCornerY)) return true
  const ccx = x < RECT_L + RADIUS ? RECT_L + RADIUS : RECT_R - RADIUS
  const ccy = y < RECT_T + RADIUS ? RECT_T + RADIUS : RECT_B - RADIUS
  const dx = x - ccx
  const dy = y - ccy
  return dx * dx + dy * dy <= RADIUS * RADIUS
}

/** 单点采样：返回 [r,g,b,a]。 */
function sample(sx, sy) {
  if (!pointInRoundedRect(sx, sy)) return [0, 0, 0, 0]
  const t = (sy - RECT_T) / (RECT_B - RECT_T)
  const r = Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
  const g = Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
  const b = Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
  if (pointInSparkle(sx, sy)) return [255, 255, 255, 255]
  return [r, g, b, 255]
}

// 输出像素：2×2 超采样抗锯齿（premultiplied alpha 平均）
const px = new Uint8Array(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let accR = 0,
      accG = 0,
      accB = 0,
      accA = 0
    const subs = [
      [x + 0.25, y + 0.25],
      [x + 0.75, y + 0.25],
      [x + 0.25, y + 0.75],
      [x + 0.75, y + 0.75],
    ]
    for (const [sx, sy] of subs) {
      const [r, g, b, a] = sample(sx, sy)
      accR += (r * a) / 255
      accG += (g * a) / 255
      accB += (b * a) / 255
      accA += a
    }
    const n = subs.length
    const aOut = Math.round(accA / n)
    let rOut = 0,
      gOut = 0,
      bOut = 0
    if (aOut > 0) {
      // un-premultiply（超采样平均后的还原）
      rOut = Math.round((accR / n) * (255 / aOut))
      gOut = Math.round((accG / n) * (255 / aOut))
      bOut = Math.round((accB / n) * (255 / aOut))
    }
    const o = (y * SIZE + x) * 4
    px[o] = rOut
    px[o + 1] = gOut
    px[o + 2] = bOut
    px[o + 3] = aOut
  }
}

// ---------------------------------------------------------------------------
// PNG / ICO 编码
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng() {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0
    raw.set(
      px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4),
      y * (SIZE * 4 + 1) + 1,
    )
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** PNG-in-ICO（Vista+，单尺寸 256）：electron-builder / 资源管理器均支持。 */
function encodeIco(pngBuf) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0) // reserved
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(1, 4) // count
  const entry = Buffer.alloc(16)
  entry[0] = 0 // width 256 → 0
  entry[1] = 0 // height 256 → 0
  entry[2] = 0 // palette
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(pngBuf.length, 8)
  entry.writeUInt32LE(22, 12) // offset: 6 + 16
  return Buffer.concat([head, entry, pngBuf])
}

const png = encodePng()
writeFileSync(OUT_RUNTIME, png)
writeFileSync(OUT_BUILD_PNG, png)
writeFileSync(OUT_BUILD_ICO, encodeIco(png))
console.log(
  '[gen-icon] grape Sparkles written:',
  OUT_RUNTIME,
  OUT_BUILD_PNG,
  OUT_BUILD_ICO,
  `(${png.length} bytes png)`,
)
