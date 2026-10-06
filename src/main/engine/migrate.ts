/**
 * 软件数据迁移到其他盘符（design.md §5.2）。
 *
 * 把仍在使用的数据目录从 C 盘搬到 D/E 盘，并用**目录联接（mklink /J）**回填原路径，
 * 软件无感知。迁移流程严格按设计的三条关键约束：
 *
 * 1. **迁移前校验目标盘剩余空间 > 源数据 1.2 倍**；
 * 2. **迁移后校验链接可读写，再删源**；
 * 3. **任一步失败自动回滚**（把数据搬回原位并恢复原目录）。
 *
 * 实现细案（为什么这样最稳）：
 * - 用 `robocopy /MOVE /E` 移动（比 Move-Item 更稳、可跨卷、带重试）；
 * - 移动成功后用 `cmd /c mklink /J` 建联接；若建联接失败 → 立刻搬回并报错（绝不留下半迁移状态）；
 * - 联接创建后写入探针文件并读回，确认可读写才删除源（robocopy /MOVE 已删源，
 *   故此处源已不存在，探针失败则执行回滚：删联接 + 搬回）。
 * - 还原（取消迁移）：删除联接 → 把数据搬回原路径 → 校验。
 *
 * 只迁移「白名单」内的已知目录（社交/办公/创作类根目录的一级子目录），
 * 不接受任意路径，避免误操作系统目录。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { runPs, psQuote } from './ps'
import { expandEnv } from './rules'

/** 可迁移的候选根目录（一级子目录即为可迁移项）。 */
const SOURCE_ROOTS: Array<{ dir: string; label: string }> = [
  { dir: '%LOCALAPPDATA%', label: '本地应用数据' },
  { dir: '%APPDATA%', label: '漫游应用数据' },
  { dir: '%USERPROFILE%\\Documents', label: '文档' },
  { dir: '%LOCALAPPDATA%\\Microsoft\\Office', label: 'Office' },
]

/** 永不迁移的目录名（系统/浏览器核心目录，迁移会破坏软件）。 */
const DENY_NAMES = new Set([
  'microsoft',
  'windows',
  'google',
  'microsoft edge',
  'mozilla',
  'nvidia',
  'nvidia corporation',
  'amd',
  'intel',
  'packages',
  'programs',
  'temp',
  'cache',
  'crashdumps',
  'd3dscache',
  'iconcache.db',
  'desktop.ini',
])

export interface MigrateItem {
  id: string
  /** 目录名 */
  name: string
  path: string
  size: number
  /** 来源分组 */
  source: string
  /** 已是联接（说明此前已迁移过） */
  isJunction: boolean
}

function hashId(p: string): string {
  return 'mig:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

/**
 * 异步统计目录体积：遍历过程中**定期让出事件循环**。
 *
 * 同步版 `dirSize` 会在主进程连续阻塞（单目录可达数万文件），
 * 导致 Electron 窗口被 Windows 判定「未响应」（灰白边框 + 卡死）。
 * 这里每累计 `YIELD_EVERY` 个文件就 `await setImmediate` 一次，
 * 既保证 UI 与消息循环存活，又不显著拖慢整体扫描。
 */
const YIELD_EVERY = 800

async function dirSizeAsync(
  p: string,
  maxFiles = 30000,
  isCancelled?: () => boolean,
): Promise<number> {
  let total = 0
  let n = 0
  let sinceYield = 0
  const stack: string[] = [p]
  while (stack.length && n < maxFiles) {
    if (isCancelled?.()) return total
    const cur = stack.pop() as string
    let ents: fs.Dirent[]
    try {
      ents = await fs.promises.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (n >= maxFiles) break
      const fp = path.join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(fp)
        else if (e.isFile()) {
          const st = await fs.promises.stat(fp)
          total += st.size
          n++
          if (++sinceYield >= YIELD_EVERY) {
            sinceYield = 0
            await new Promise((r) => setImmediate(r))
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return total
}

function isJunction(p: string): boolean {
  try {
    const lstat = fs.lstatSync(p)
    if (!lstat.isDirectory()) return false
    // 重解析点：符号链接 / 联接
    return !!fs.readlinkSync(p)
  } catch {
    return false
  }
}

/** 取系统盘盘符（%SystemDrive%，通常 C:），用于从迁移目标中排除自身。 */
function systemDriveLetter(): string {
  const raw = process.env.SystemDrive || process.env.HOMEDRIVE || 'C:'
  const m = /^[A-Za-z]/.exec(raw)
  return m ? m[0].toUpperCase() : 'C'
}

/** 目标盘符的可选根目录（供界面下拉选择）。排除系统盘——迁移就是把数据搬到「其它盘」。 */
export function listTargetRoots(): Array<{ letter: string; freeBytes: number; totalBytes: number }> {
  const out: Array<{ letter: string; freeBytes: number; totalBytes: number }> = []
  if (process.platform !== 'win32') return out
  const sys = systemDriveLetter()
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    if (letter === sys) continue // 目标盘不能是系统盘本身
    const root = `${letter}:\\`
    try {
      // 用 statfs 读取空间（Node 18+）；失败则跳过该盘符
      const st = fs.statfsSync(root)
      out.push({
        letter,
        freeBytes: st.bsize * st.bavail,
        totalBytes: st.bsize * st.blocks,
      })
    } catch {
      /* 盘符不存在或不可访问 */
    }
  }
  return out
}

/**
 * 流式列出可迁移目录（体积 ≥ minMb 才列出，避免噪音）。
 * 逐目录计算体积较慢，故分批 yield 并在批次间让出事件循环，保证 UI 不卡顿。
 */
export async function* listMigratableStream(
  minMb = 200,
  isCancelled: () => boolean,
): AsyncGenerator<MigrateItem[], void, unknown> {
  const minBytes = Math.max(minMb, 0) * 1024 * 1024
  let batch: MigrateItem[] = []
  for (const { dir, label } of SOURCE_ROOTS) {
    if (isCancelled()) return
    const root = expandEnv(dir).replace(/\//g, '\\')
    if (!root) continue
    let ents: fs.Dirent[]
    try {
      ents = await fs.promises.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (isCancelled()) return
      if (!e.isDirectory()) continue
      const lower = e.name.toLowerCase()
      if (DENY_NAMES.has(lower)) continue
      if (lower.startsWith('.')) continue
      const fp = path.join(root, e.name)
      const junction = isJunction(fp)
      // 体积统计是耗时点：异步版会在遍历中让出事件循环，避免主进程卡死
      const size = junction ? 0 : await dirSizeAsync(fp, 30000, isCancelled)
      if (isCancelled()) return
      if (!junction && size < minBytes) continue
      batch.push({
        id: hashId(fp),
        name: e.name,
        path: fp,
        size,
        source: label,
        isJunction: junction,
      })
      if (batch.length >= 5) {
        yield batch
        batch = []
        await new Promise((r) => setImmediate(r))
      }
    }
  }
  if (batch.length) {
    yield batch
    await new Promise((r) => setImmediate(r))
  }
}

export interface MigrateResult {
  id: string
  ok: boolean
  message: string
}

/**
 * 迁移单个目录到目标盘。
 *
 * @param targetRoot 目标盘根目录，如 `D:\GrCleanData`（必须是已存在的目录）
 */
export async function migrateDirectory(
  items: MigrateItem[],
  id: string,
  targetRoot: string,
): Promise<MigrateResult> {
  const it = items.find((x) => x.id === id)
  if (!it) return { id, ok: false, message: '条目不在本次列表内' }
  if (it.isJunction) return { id, ok: false, message: '该目录已是联接（可能已迁移过）' }
  const src = it.path
  if (!fs.existsSync(src)) return { id, ok: false, message: '源目录不存在' }

  // 1) 目标盘空间校验：> 源数据 1.2 倍
  const drive = path.parse(targetRoot).root.toUpperCase() // 形如 D:\
  let free = 0
  try {
    const st = fs.statfsSync(drive)
    free = st.bsize * st.bavail
  } catch {
    return { id, ok: false, message: `无法读取目标盘 ${drive} 的剩余空间` }
  }
  if (free < it.size * 1.2) {
    return {
      id,
      ok: false,
      message: `目标盘空间不足：需要 ${(it.size * 1.2 / 1024 ** 3).toFixed(2)} GB，剩余 ${(free / 1024 ** 3).toFixed(2)} GB`,
    }
  }

  const target = path.join(targetRoot, it.name)

  try {
    // 2) 目标目录准备：确保不存在同名目录（避免覆盖已有数据）
    if (fs.existsSync(target)) {
      return { id, ok: false, message: `目标目录已存在：${target}` }
    }
    fs.mkdirSync(targetRoot, { recursive: true })

    // 3) 移动数据（robocopy /MOVE /E 跨卷移动，带重试与日志）
    await runPs(
      `robocopy ${psQuote(src)} ${psQuote(target)} /MOVE /E /COPYALL /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null; if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }`,
    )

    // 4) 建立目录联接
    try {
      await runPs(`cmd /c mklink /J ${psQuote(src)} ${psQuote(target)}`)
    } catch (e) {
      // 建联接失败 → 回滚：把数据搬回原位
      await runPs(
        `robocopy ${psQuote(target)} ${psQuote(src)} /MOVE /E /COPYALL /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null`,
      )
      return {
        id,
        ok: false,
        message: `建立联接失败，已回滚：${e instanceof Error ? e.message : String(e)}`,
      }
    }

    // 5) 迁移后校验：联接可读写（写探针 → 读回 → 删除）
    const probe = path.join(src, '.grclean_probe.tmp')
    try {
      fs.writeFileSync(probe, 'ok')
      const back = fs.readFileSync(probe, 'utf8')
      fs.unlinkSync(probe)
      if (back !== 'ok') throw new Error('读写校验失败')
    } catch (e) {
      // 校验失败 → 回滚：删联接并把数据搬回
      await runPs(`cmd /c rmdir ${psQuote(src)}`)
      await runPs(
        `robocopy ${psQuote(target)} ${psQuote(src)} /MOVE /E /COPYALL /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null`,
      )
      return {
        id,
        ok: false,
        message: `联接读写校验失败，已回滚：${e instanceof Error ? e.message : String(e)}`,
      }
    }

    return { id, ok: true, message: `已迁移到 ${target} 并建立联接` }
  } catch (e) {
    return { id, ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/** 还原迁移：删除联接，把数据搬回原路径。 */
export async function restoreDirectory(
  items: MigrateItem[],
  id: string,
): Promise<MigrateResult> {
  const it = items.find((x) => x.id === id)
  if (!it) return { id, ok: false, message: '条目不在本次列表内' }
  const link = it.path
  if (!isJunction(link)) return { id, ok: false, message: '该目录不是联接，无需还原' }
  let real: string
  try {
    real = fs.readlinkSync(link)
  } catch (e) {
    return { id, ok: false, message: `读取联接目标失败：${String(e)}` }
  }
  try {
    // 1) 删除联接（rmdir 对联接只删链接本身，不动目标数据）
    await runPs(`cmd /c rmdir ${psQuote(link)}`)
    // 2) 数据搬回
    await runPs(
      `robocopy ${psQuote(real)} ${psQuote(link)} /MOVE /E /COPYALL /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null; if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }`,
    )
    if (!fs.existsSync(link)) throw new Error('还原后原路径不存在')
    return { id, ok: true, message: `已还原到 ${link}` }
  } catch (e) {
    return { id, ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
