import fg from 'fast-glob'
import fs from 'fs'
import { type BigFileEntry } from './model'

const BATCH = 40

// 常见用户数据目录：英文 + 中文（适配中文 Windows）各取首个存在的
const USER_FOLDER_CANDIDATES: Record<string, string[]> = {
  Desktop: ['Desktop', '桌面'],
  Documents: ['Documents', '文档'],
  Downloads: ['Downloads', '下载'],
  Pictures: ['Pictures', '图片'],
  Videos: ['Videos', '视频'],
  Music: ['Music', '音乐'],
}

/** 解析存在的用户数据目录（USERPROFILE 下的已知文件夹）。 */
export function userDirs(): string[] {
  const base = process.env.USERPROFILE || process.env.HOME || ''
  if (!base) return []
  const out: string[] = []
  for (const names of Object.values(USER_FOLDER_CANDIDATES)) {
    for (const name of names) {
      const p = `${base}\\${name}`
      if (fs.existsSync(p)) {
        out.push(p)
        break
      }
    }
  }
  return out
}

/** 枚举存在的本地磁盘根（A:~Z:），实现「全盘」分析。 */
export function allDrives(): string[] {
  const roots: string[] = []
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`
    try {
      if (fs.existsSync(root)) roots.push(root)
    } catch {
      /* 不可访问的盘符（如空软驱）直接跳过 */
    }
  }
  return roots
}

export interface BigFileScanOpts {
  /** 最小体积（字节） */
  minSize: number
  /** true=全部存在盘符；false=仅用户数据目录 */
  includeAll: boolean
  /** 指定单个盘符（如 'D'）时只扫描该盘根目录，优先级高于 includeAll */
  drive?: string
}

/**
 * 大文件流式扫描：async generator 逐批产出 BigFileEntry[]。
 *
 * 复用 junk 扫描的丝滑策略：fast-glob 异步 IO 不阻塞事件循环，每 40 条 yield 一批并
 * `setImmediate` 让权；主进程通过 IPC 把每批推给前端，前端逐行（unshift）增量显示。
 * 仅分析、不涉及删除。
 */
export async function* scanBigFilesStream(
  opts: BigFileScanOpts,
  isCancelled: () => boolean,
): AsyncGenerator<BigFileEntry[], void, unknown> {
  const roots = opts.drive
    ? [`${opts.drive}:\\`]
    : opts.includeAll
      ? allDrives()
      : userDirs()
  const minBytes = Math.max(opts.minSize, 1)

  for (const root of roots) {
    if (isCancelled()) return
    if (!fs.existsSync(root)) continue

    const stream = fg.stream('**/*', {
      cwd: root,
      onlyFiles: true,
      dot: false,
      suppressErrors: true,
      absolute: true,
      deep: 8,
    })

    let batch: BigFileEntry[] = []
    for await (const entry of stream) {
      if (isCancelled()) return
      const filePath = String(entry) // fast-glob stream 发出完整路径字符串
      let st: fs.Stats
      try {
        st = fs.statSync(filePath)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      if (st.size < minBytes) continue

      batch.push({ path: filePath, size: st.size })
      if (batch.length >= BATCH) {
        yield batch
        batch = []
        await new Promise((r) => setImmediate(r))
      }
    }
    if (batch.length) {
      yield batch
      batch = []
    }
  }
}
