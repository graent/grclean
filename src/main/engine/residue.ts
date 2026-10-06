/**
 * 卸载残留扫描（design.md §3.11）。
 *
 * 软件卸载后常在 `Program Files` / `AppData` 留下空壳目录，日积月累占用空间。
 * 这里用「**已安装程序清单的反查**」来判定残留：
 *
 * 1. 先从卸载注册表汇总当前**确实还装着**的程序名 / 厂商 / 安装目录名，作为白名单词元；
 * 2. 再扫描四个根目录的一级子目录，若目录名**匹配不到任何白名单词元**，才视作残留候选；
 * 3. 再叠加两个降噪条件：体积 ≥ 阈值、**长期未改动**（默认 60 天，仍在用的目录会被排除）。
 *
 * 安全策略：
 * - **默认不勾选**，且界面需二次确认后才清理（对应设计「需用户确认」）；
 * - 系统目录 / 硬件厂商目录（Microsoft、Windows、NVIDIA、Intel…）硬编码排除；
 * - 删除走 `isProtected` 拦截 + 默认回收站（`trash` 支持目录）+ 审计日志。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { collectUninstallEntries } from './uninstall'
import { expandEnv } from './rules'
import { isProtected } from './protected'
import { logDeletion } from './audit'
import { moveToRecycleBin } from './trash-bin'
import type { CleanCandidate, CleanResult } from './model'

export interface ResidueItem {
  id: string
  /** 目录名 */
  name: string
  path: string
  /** 目录总体积（字节） */
  size: number
  /** 最后修改时间（毫秒时间戳） */
  mtime: number
  /** 未改动天数 */
  days: number
  /** 所在根目录标签 */
  source: string
}

/** 永不判为残留的目录名（系统、运行时、硬件厂商、包管理器等）。 */
const DENY_NAMES = new Set([
  'microsoft',
  'microsoft shared',
  'windows',
  'windowsapps',
  'windows defender',
  'windows nt',
  'windows media player',
  'windows photo viewer',
  'windows portable devices',
  'windows sidebar',
  'common files',
  'internet explorer',
  'nvidia',
  'nvidia corporation',
  'amd',
  'intel',
  'realtek',
  'packages',
  'temp',
  'cache',
  'crashdumps',
  'desktop',
  'programs',
  'appdata',
  'default',
  'public',
  'all users',
  'nodejs',
  'python',
  'git',
  'java',
  'adobe',
])

/** 待扫描的根目录（只取一级子目录，避免深入系统目录）。 */
function scanRoots(): Array<{ dir: string; label: string }> {
  const raw: Array<{ dir: string; label: string }> = [
    { dir: '%ProgramFiles%', label: 'Program Files' },
    { dir: '%ProgramFiles(x86)%', label: 'Program Files (x86)' },
    { dir: '%LOCALAPPDATA%', label: 'AppData\\Local' },
    { dir: '%APPDATA%', label: 'AppData\\Roaming' },
  ]
  const out: Array<{ dir: string; label: string }> = []
  for (const r of raw) {
    const p = expandEnv(r.dir).replace(/\//g, '\\')
    if (!p) continue
    try {
      if (fs.statSync(p).isDirectory()) out.push({ dir: p, label: r.label })
    } catch {
      /* 根目录不存在则跳过 */
    }
  }
  return out
}

function hashId(p: string): string {
  return 'res:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

/** 归一化：只保留小写字母与数字，便于做宽松匹配。 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
}

/** 计算目录体积（带上限，避免超大目录卡死）。 */
function dirSize(dir: string, cap = 20000): number {
  let total = 0
  let n = 0
  const stack: string[] = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(full)
        continue
      }
      if (n++ > cap) return total
      try {
        total += fs.statSync(full).size
      } catch {
        /* 单文件失败忽略 */
      }
    }
  }
  return total
}

/**
 * 汇总「确实还装着」的程序词元。
 * 同时把安装目录下的真实文件夹名也纳入，避免把正在使用的目录误判为残留。
 */
async function installedTokens(): Promise<Set<string>> {
  const tokens = new Set<string>()
  try {
    const list = await collectUninstallEntries()
    for (const e of list) {
      if (e.name) tokens.add(norm(e.name))
      if (e.publisher) tokens.add(norm(e.publisher))
      if (e.install_location) {
        const parts = e.install_location.split(/[\\/]/).filter(Boolean)
        const last = parts[parts.length - 1]
        if (last) tokens.add(norm(last))
      }
    }
  } catch {
    // 采集失败时退化为「全部视为在用」，宁可漏报也不误报
    return new Set()
  }
  return tokens
}

/** 目录名是否命中白名单（宽松包含匹配，双向）。 */
function matchesInstalled(dirName: string, tokens: Set<string>): boolean {
  if (!tokens.size) return true // 采集失败 → 保守认为在用
  const n = norm(dirName)
  if (!n) return true
  for (const t of tokens) {
    if (!t) continue
    if (t === n) return true
    if (t.length >= 4 && n.includes(t)) return true
    if (n.length >= 4 && t.includes(n)) return true
  }
  return false
}

/**
 * 卸载残留流式扫描。
 * @param minSizeMb 体积下限（MB，默认 10）
 * @param minDays   未改动天数下限（默认 60）
 */
export async function* scanResidueStream(
  minSizeMb: number,
  minDays: number,
  isCancelled: () => boolean,
): AsyncGenerator<ResidueItem[], void, unknown> {
  const minBytes = Math.max(minSizeMb, 0) * 1024 * 1024
  const cutoff = Date.now() - Math.max(minDays, 0) * 86400_000
  const tokens = await installedTokens()
  const roots = scanRoots()

  let batch: ResidueItem[] = []
  for (const root of roots) {
    if (isCancelled()) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (isCancelled()) return
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      const lower = e.name.toLowerCase()
      if (DENY_NAMES.has(lower)) continue
      if (lower.startsWith('microsoft')) continue
      const full = path.join(root.dir, e.name)
      let st: fs.Stats | null = null
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      // 仍在被写入的目录说明软件还在用，排除
      if (st.mtimeMs > cutoff) continue
      if (matchesInstalled(e.name, tokens)) continue
      const size = dirSize(full)
      if (size < minBytes) continue
      batch.push({
        id: hashId(full),
        name: e.name,
        path: full,
        size,
        mtime: Math.round(st.mtimeMs),
        days: Math.floor((Date.now() - st.mtimeMs) / 86400_000),
        source: root.label,
      })
      if (batch.length >= 10) {
        yield batch
        batch = []
        await new Promise((r) => setImmediate(r))
      }
    }
  }
  if (batch.length) yield batch
}

/** 删除卸载残留目录（默认回收站，purge 才永久删除）。 */
export async function deleteResidue(
  items: Map<string, ResidueItem>,
  ids: string[],
  purge: boolean,
): Promise<CleanResult> {
  const result: CleanResult = {
    deleted_count: 0,
    deleted_size: 0,
    skipped: [],
    errors: [],
  }
  const audit: CleanCandidate[] = []

  for (const id of ids) {
    const it = items.get(id)
    if (!it) {
      result.skipped.push({ id, path: '', reason: '条目不在本次扫描会话内' })
      continue
    }
    if (isProtected(it.path)) {
      result.skipped.push({ id, path: it.path, reason: '受保护路径，已拦截' })
      continue
    }
    let st: fs.Stats | null = null
    try {
      st = fs.statSync(it.path)
    } catch {
      result.skipped.push({ id, path: it.path, reason: '目录已不存在' })
      continue
    }
    if (!st.isDirectory()) {
      result.skipped.push({ id, path: it.path, reason: '非目录，已跳过' })
      continue
    }
    try {
      if (purge) fs.rmSync(it.path, { recursive: true, force: true })
      else await moveToRecycleBin(it.path)
      result.deleted_count += 1
      result.deleted_size += it.size
      audit.push({
        id,
        path: it.path,
        size: it.size,
        category: '卸载残留',
        rule_id: 'residue',
      })
    } catch (e) {
      result.errors.push(`${it.path}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (audit.length) logDeletion(audit, purge)
  return result
}
