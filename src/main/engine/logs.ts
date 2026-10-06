/**
 * 无用日志清理（design.md §3.8）。
 *
 * 清理 `*.log`、崩溃转储（*.dmp）、WER 报告、应用级临时日志。
 * **系统关键日志默认跳过** —— 扫描根仅限用户级目录（LocalAppData / Roaming / Temp /
 * CrashDumps），`C:\Windows` 等系统目录不在范围内，且删除时再经 `isProtected` 拦截，
 * 双重保证不会动系统日志。
 *
 * 分三组呈现（对应设计的「应用级与临时级」）：
 * - app：应用日志（LocalAppData / Roaming 下的 *.log）
 * - temp：临时日志（Temp 下的 *.log / *.txt 日志）
 * - crash：崩溃转储与错误报告（CrashDumps *.dmp、WER 报告目录）
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import fg from 'fast-glob'
import { expandEnv } from './rules'
import { isProtected } from './protected'
import { logDeletion } from './audit'
import { moveToRecycleBin } from './trash-bin'
import type { CleanResult } from './model'

export type LogGroup = 'app' | 'temp' | 'crash'

export const LOG_GROUP_META: Record<
  LogGroup,
  { label: string; desc: string; recommend: boolean }
> = {
  app: { label: '应用日志', desc: '软件运行产生的 .log，可安全清理', recommend: true },
  temp: { label: '临时日志', desc: '临时目录下的日志与调试输出', recommend: true },
  crash: {
    label: '崩溃转储 / 错误报告',
    desc: '*.dmp 与 WER 报告，体积大但不影响系统',
    recommend: false,
  },
}

export interface LogItem {
  id: string
  group: LogGroup
  /** 条目名（文件名或报告目录名） */
  name: string
  path: string
  size: number
  /** 修改时间（毫秒时间戳） */
  mtime: number
}

function hashId(p: string): string {
  return 'log:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

function dirSize(p: string, maxFiles = 5000): number {
  let total = 0
  let n = 0
  const stack: string[] = [p]
  while (stack.length && n < maxFiles) {
    const cur = stack.pop() as string
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (n >= maxFiles) break
      const fp = path.join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(fp)
        else if (e.isFile()) {
          total += fs.statSync(fp).size
          n++
        }
      } catch {
        /* ignore */
      }
    }
  }
  return total
}

/** 崩溃转储 / WER 报告目录（用户级，系统级已排除）。 */
function crashRoots(): Array<{ root: string; label: string }> {
  const raw: Array<[string, string]> = [
    ['%LOCALAPPDATA%\\CrashDumps', '崩溃转储'],
    ['%LOCALAPPDATA%\\Microsoft\\Windows\\WER', 'WER 报告'],
    ['%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportArchive', 'WER 归档'],
    ['%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportQueue', 'WER 队列'],
  ]
  const out: Array<{ root: string; label: string }> = []
  for (const [r, label] of raw) {
    const p = expandEnv(r).replace(/\//g, '\\')
    if (!p) continue
    try {
      if (fs.existsSync(p)) out.push({ root: p, label })
    } catch {
      /* ignore */
    }
  }
  return out
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

/** 扫描根描述：deep 可覆盖默认递归深度（整盘扫描时需要更大深度）。 */
interface LogScanRoot {
  root: string
  group: LogGroup
  deep?: number
}

/** 系统盘盘符（WINDIR/SystemDrive/USERPROFILE 推断，兼容非 C: 系统盘）。 */
function systemDriveLetter(): string {
  for (const raw of [process.env.SystemDrive, process.env.WINDIR, process.env.USERPROFILE]) {
    const v = (raw || '').trim().replace(/\//g, '\\')
    if (/^[a-zA-Z]:/.test(v)) return v[0].toUpperCase()
  }
  return 'C'
}

/** 当前用户的固定日志目录（恒在系统盘，快且准）。 */
function defaultUserRoots(): LogScanRoot[] {
  const out: LogScanRoot[] = []
  for (const r of ['%LOCALAPPDATA%', '%APPDATA%']) {
    const p = expandEnv(r).replace(/\//g, '\\')
    if (p && fs.existsSync(p)) out.push({ root: p, group: 'app' })
  }
  const temp = expandEnv('%TEMP%').replace(/\//g, '\\')
  if (temp && fs.existsSync(temp)) out.push({ root: temp, group: 'temp' })
  return out
}

/** 整盘扫描时需要排除的系统目录（避免把其他盘的 Windows/回收站垃圾当日志）。 */
const DRIVE_IGNORE = [
  '**/$Recycle.Bin/**',
  '**/$RECYCLE.BIN/**',
  '**/System Volume Information/**',
  '**/Windows/**',
  '**/WinSxS/**',
  '**/Recovery/**',
  '**/$WinREAgent/**',
]

/**
 * 指定盘符下的日志扫描根。
 *
 * 关键点：固定 user 级目录（%LOCALAPPDATA% 等）永远落在系统盘，所以：
 * - 系统盘 → 用固定用户目录（快，且正是绝大多数应用日志的所在）；
 * - 其他盘 → 直接扫**盘根**（日志可能在任意位置，如 `D:\apps\run\server.log`，
 *   只扫 ProgramData / Users 会漏掉绝大多数），并排除系统目录降噪。
 */
function logRootsOnDrive(drive: string): LogScanRoot[] {
  const d = (drive || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1)
  if (!d) return []
  if (d === systemDriveLetter()) return defaultUserRoots()
  const root = `${d}:\\`
  try {
    if (!fs.existsSync(root)) return []
  } catch {
    return []
  }
  return [{ root, group: 'app', deep: 8 }]
}

/** 解析本次扫描的根集合。''/'all' = 用户目录 + 所有非系统盘盘根。 */
function resolveScanRoots(drive: string): LogScanRoot[] {
  const d = (drive || '').trim()
  if (d && d !== 'all') return logRootsOnDrive(d)
  const roots = defaultUserRoots()
  const sys = systemDriveLetter()
  for (const dr of allDriveLetters()) {
    if (dr === sys) continue
    const root = `${dr}:\\`
    try {
      if (fs.existsSync(root)) roots.push({ root, group: 'app', deep: 8 })
    } catch {
      /* ignore */
    }
  }
  return roots
}

/** 枚举存在的盘符字母（A:~Z:）。 */
function allDriveLetters(): string[] {
  const out: string[] = []
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c)
    try {
      if (fs.existsSync(`${letter}:\\`)) out.push(letter)
    } catch {
      /* 不可访问的盘符跳过 */
    }
  }
  return out
}

/**
 * 日志流式扫描。
 * @param minDays 仅列出 N 天前的文件（0 = 不限）
 * @param drive   扫描范围：'' / 'all' = 所有盘符；'C' / 'D'… = 仅该盘符下的用户日志
 */
export async function* scanLogsStream(
  minDays: number,
  drive: string,
  isCancelled: () => boolean,
): AsyncGenerator<LogItem[], void, unknown> {
  const cutoff = Math.max(minDays, 0) > 0 ? Date.now() - minDays * 86400_000 : 0

  // 1) 应用日志 / 临时日志：*.log
  // 默认（'' / 'all'）：当前用户 profile 下的日志目录 + 所有非系统盘盘根。
  // 指定具体盘符：系统盘用用户目录；其他盘直接扫盘根（见 logRootsOnDrive）。
  const scanRoots = resolveScanRoots(drive)

  for (const { root, group, deep } of scanRoots) {
    if (isCancelled()) return
    let batch: LogItem[] = []
    // ⚠️ 必须用 fg.stream 边遍历边产出：盘根扫描（整盘）一次 `await fg()` 要等
    // 几十秒才返回，期间前端一条结果都收不到，看起来就像「扫不出来」。
    const stream = fg.stream('**/*.log', {
      cwd: root,
      onlyFiles: true,
      dot: false,
      absolute: true,
      deep: deep ?? 6,
      ignore: DRIVE_IGNORE,
      suppressErrors: true,
    })
    try {
      for await (const entry of stream) {
        if (isCancelled()) return
        const p = String(entry)
        const st = statSafe(p)
        if (!st || !st.isFile()) continue
        if (cutoff && st.mtimeMs > cutoff) continue
        if (st.size === 0) continue
        batch.push({
          id: hashId(p),
          group,
          name: path.basename(p),
          path: p,
          size: st.size,
          mtime: Math.round(st.mtimeMs),
        })
        if (batch.length >= 40) {
          yield batch
          batch = []
          await new Promise((r) => setImmediate(r))
        }
      }
    } catch {
      /* 目录不可访问等：跳过该扫描根 */
    } finally {
      // 提前 return（取消）时销毁流，避免继续遍历整盘
      try {
        ;(stream as unknown as { destroy?: () => void }).destroy?.()
      } catch {
        /* ignore */
      }
    }
    if (batch.length) {
      yield batch
      await new Promise((r) => setImmediate(r))
    }
  }

  // 2) 崩溃转储 / WER 报告：整体按目录统计（*.dmp 单文件 + 报告目录）
  //    这些目录恒在系统盘，选定非系统盘时不应出现（避免「选 D: 却列出 C: 的转储」）。
  const dv = (drive || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1)
  const crashList =
    dv && dv !== 'ALL'
      ? crashRoots().filter((c) => c.root.toUpperCase().startsWith(dv + ':'))
      : crashRoots()
  for (const { root, label } of crashList) {
    if (isCancelled()) return
    const batch: LogItem[] = []
    let dmpFiles: string[] = []
    try {
      dmpFiles = await fg('**/*.dmp', {
        cwd: root,
        onlyFiles: true,
        dot: false,
        absolute: true,
        deep: 4,
        suppressErrors: true,
      })
    } catch {
      /* ignore */
    }
    for (const p of dmpFiles) {
      if (isCancelled()) return
      const st = statSafe(p)
      if (!st || !st.isFile()) continue
      if (cutoff && st.mtimeMs > cutoff) continue
      batch.push({
        id: hashId(p),
        group: 'crash',
        name: path.basename(p),
        path: p,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
      })
    }
    // 报告目录本身（无 .dmp 时也有体积）
    let ents: fs.Dirent[] = []
    try {
      ents = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      ents = []
    }
    for (const e of ents) {
      if (isCancelled()) return
      if (!e.isDirectory()) continue
      const fp = path.join(root, e.name)
      const size = dirSize(fp)
      if (size <= 0) continue
      const st = statSafe(fp)
      if (cutoff && st && st.mtimeMs > cutoff) continue
      batch.push({
        id: hashId(fp),
        group: 'crash',
        name: `${label} · ${e.name}`,
        path: fp,
        size,
        mtime: st ? Math.round(st.mtimeMs) : 0,
      })
    }
    if (batch.length) {
      yield batch
      await new Promise((r) => setImmediate(r))
    }
  }
}

/** 展开待删条目 → 文件清单（崩溃组是目录，需展开）。 */
function expandFiles(item: LogItem): string[] {
  const st = statSafe(item.path)
  if (!st) return []
  if (st.isFile()) return [item.path]
  const out: string[] = []
  const stack: string[] = [item.path]
  const cap = 5000
  while (stack.length && out.length < cap) {
    const cur = stack.pop() as string
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (out.length >= cap) break
      const fp = path.join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(fp)
        else if (e.isFile()) out.push(fp)
      } catch {
        /* ignore */
      }
    }
  }
  return out
}

/** 删除日志条目（默认回收站；系统关键路径由 isProtected 拦截）。 */
export async function deleteLogs(
  items: Map<string, LogItem>,
  ids: string[],
  purge: boolean,
): Promise<CleanResult> {
  const result: CleanResult = {
    deleted_count: 0,
    deleted_size: 0,
    skipped: [],
    errors: [],
  }
  const audit: import('./model').CleanCandidate[] = []

  for (const id of ids) {
    const it = items.get(id)
    if (!it) {
      result.skipped.push({ id, path: '', reason: '条目不在本次扫描会话内' })
      continue
    }
    for (const fp of expandFiles(it)) {
      if (isProtected(fp)) {
        result.skipped.push({ id, path: fp, reason: '受保护路径（系统日志），已拦截' })
        continue
      }
      const st = statSafe(fp)
      if (!st) continue
      try {
        if (purge) fs.unlinkSync(fp)
        else await moveToRecycleBin(fp)
        result.deleted_count += 1
        result.deleted_size += st.size
        audit.push({
          id,
          path: fp,
          size: st.size,
          category: `日志·${LOG_GROUP_META[it.group].label}`,
          rule_id: `log:${it.group}`,
        })
      } catch (e) {
        result.errors.push(`${fp}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  if (audit.length) logDeletion(audit, purge)
  return result
}
