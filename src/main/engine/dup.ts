import crypto from 'crypto'
import fg from 'fast-glob'
import fs from 'fs'
import { type DuplicateGroup } from './model'
import { userDirs, allDrives } from './bigfile'

const HEADER_BYTES = 4096
const TAIL_BYTES = 4096

/** 由路径生成稳定 id（同一文件每次扫描 id 相同，便于前端维持勾选状态）。 */
function hashId(p: string): string {
  return crypto.createHash('md5').update(p.toLowerCase()).digest('hex')
}

/** 头部哈希预筛：读文件头 4KB + 尾 4KB 做 SHA-256，快速排除「大小相同但内容不同」。 */
function headerHash(path: string): string | null {
  let fd: number
  try {
    fd = fs.openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const total = fs.fstatSync(fd).size
    let buf = Buffer.alloc(0)
    const headLen = Math.min(HEADER_BYTES, total)
    if (headLen > 0) {
      const head = Buffer.alloc(headLen)
      fs.readSync(fd, head, 0, headLen, 0)
      buf = Buffer.concat([buf, head])
    }
    if (total > HEADER_BYTES + TAIL_BYTES) {
      const tail = Buffer.alloc(TAIL_BYTES)
      fs.readSync(fd, tail, 0, TAIL_BYTES, total - TAIL_BYTES)
      buf = Buffer.concat([buf, tail])
    }
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* 关闭失败忽略 */
    }
  }
}

/** 全量哈希：流式读取整个文件计算 SHA-256，作为重复判定的最终依据。 */
function fullHash(path: string): string | null {
  let fd: number
  try {
    fd = fs.openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const h = crypto.createHash('sha256')
    const buf = Buffer.alloc(65536)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
    return h.digest('hex')
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* 关闭失败忽略 */
    }
  }
}

export interface DupScanOpts {
  /** 最小文件体积（MB），过滤极小文件以降低噪音 */
  minMb: number
  /** 自定义扫描目录；为空则按 drive 决定扫描范围 */
  dirs?: string[] | null
  /** 扫描盘符：''=默认用户数据目录；'all'=全部盘符；'C'/'D'…=仅该盘根目录 */
  drive?: string
}

/** 流式事件：progress=哈希进度（已处理文件数）；group=新发现的重复组。 */
export type DupScanEvent =
  | { type: 'progress'; n: number }
  | { type: 'group'; group: DuplicateGroup }

/**
 * 重复文件扫描（三级筛选：大小 → 头部哈希 → 全量 SHA-256）。
 *
 * 与垃圾清理/大文件同构：async generator 逐步产出事件；fast-glob 收集阶段不阻塞
 * 事件循环，哈希阶段每处理若干文件 `setImmediate` 让权，保证 UI 不卡顿、可随时取消。
 * 每构建出一个重复组即 yield，前端「边扫边显示」逐组从上方插入。
 */
export async function* scanDuplicatesStream(
  opts: DupScanOpts,
  isCancelled: () => boolean,
): AsyncGenerator<DupScanEvent, void, unknown> {
  const minBytes = Math.max(opts.minMb, 0) * 1024 * 1024
  let roots: string[]
  if (opts.dirs && opts.dirs.length) {
    roots = opts.dirs
  } else if (opts.drive === 'all') {
    roots = allDrives()
  } else if (opts.drive) {
    roots = [`${opts.drive.toUpperCase()}:\\`]
  } else {
    roots = userDirs()
  }
  if (!roots.length) return

  // 1) 收集文件（fast-glob 异步 IO，不阻塞事件循环）
  const files: Array<{ path: string; size: number }> = []
  for (const root of roots) {
    if (isCancelled()) return
    if (!fs.existsSync(root)) continue
    const stream = fg.stream('**/*', {
      cwd: root,
      onlyFiles: true,
      dot: false,
      suppressErrors: true,
      absolute: true,
      deep: 16,
    })
    for await (const entry of stream) {
      if (isCancelled()) return
      const p = String(entry)
      let st: fs.Stats
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      if (st.size < minBytes) continue
      files.push({ path: p, size: st.size })
    }
  }
  if (!files.length) return

  // 2) 按大小分组，仅保留 >= 2 个的组
  const bySize = new Map<number, Array<{ path: string; size: number }>>()
  for (const f of files) {
    if (f.size === 0) continue
    const arr = bySize.get(f.size)
    if (arr) arr.push(f)
    else bySize.set(f.size, [f])
  }
  const sizeGroups = Array.from(bySize.values()).filter((g) => g.length >= 2)
  if (!sizeGroups.length) return

  // 3) 头部哈希预筛（4KB 头 + 4KB 尾），按 (size, header) 分组
  const byHeader = new Map<string, Array<{ path: string; size: number }>>()
  let processed = 0
  for (const g of sizeGroups) {
    for (const f of g) {
      if (isCancelled()) return
      const h = headerHash(f.path)
      if (h) {
        const key = `${f.size}:${h}`
        const arr = byHeader.get(key)
        if (arr) arr.push(f)
        else byHeader.set(key, [f])
      }
      if (++processed % 20 === 0) await new Promise((r) => setImmediate(r))
    }
  }
  const headerGroups = Array.from(byHeader.values()).filter((g) => g.length >= 2)
  if (!headerGroups.length) return

  // 4) 全量 SHA-256 确认（最耗时阶段：周期上报进度并让权）
  const totalToHash = headerGroups.reduce((s, g) => s + g.length, 0)
  yield { type: 'progress', n: totalToHash }
  const byFull = new Map<string, Array<{ path: string; size: number }>>()
  let done = 0
  for (const g of headerGroups) {
    for (const f of g) {
      if (isCancelled()) return
      const h = fullHash(f.path)
      done += 1
      if (done % 10 === 0 || done === totalToHash) {
        yield { type: 'progress', n: done }
      }
      if (h) {
        const arr = byFull.get(h)
        if (arr) arr.push(f)
        else byFull.set(h, [f])
      }
      await new Promise((r) => setImmediate(r))
    }
  }

  // 5) 构建重复组并逐组产出（前端边扫边显示）
  for (const [hash, fv] of byFull) {
    if (fv.length < 2) continue
    const size = fv[0].size
    const count = fv.length
    const group: DuplicateGroup = {
      group_id: hash,
      hash,
      size,
      count,
      wasted: size * (count - 1),
      files: fv.map((f) => ({ id: hashId(f.path), path: f.path, size: f.size })),
    }
    yield { type: 'group', group }
    await new Promise((r) => setImmediate(r))
  }
}
