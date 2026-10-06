/**
 * 安装包清理（design.md §3.7）。
 *
 * 扫描常见下载目录中的 `*.exe / *.msi / *.iso / *.zip / *.rar / *.7z`，
 * 按「超过 N 天且体积 > 阈值」列出。**不自动删**，需用户勾选确认。
 *
 * 安装包特征识别（避免把日常工作文档误判为安装包）：
 * - 扩展名命中安装包集合；
 * - 且（文件名含 setup/install/安装包/驱动 等关键字，或体积 ≥ 10MB）。
 *
 * 删除沿用纵深防御：会话 id 反查 → `isProtected` → 仅文件 → 默认回收站 → 审计。
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

/** 安装包相关扩展名。 */
const EXTS = ['exe', 'msi', 'iso', 'zip', 'rar', '7z', 'cab', 'msix', 'appx']

/** 文件名特征关键字（命中即可认定为安装包，即便体积不大）。 */
const NAME_HINTS = [
  'setup',
  'install',
  'installer',
  'uninstall',
  'driver',
  '安装包',
  '驱动',
  '绿色版',
  'portable',
]

/** 体积 ≥ 此值即视为安装包候选（即便文件名无特征）。 */
const BIG_ENOUGH = 10 * 1024 * 1024

export interface InstallerItem {
  id: string
  path: string
  size: number
  /** 修改时间（毫秒时间戳） */
  mtime: number
  /** 文件天数 */
  days: number
  ext: string
  /** 是否命中文件名特征 */
  byName: boolean
}

function hashId(p: string): string {
  return 'ins:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

/** 待扫描的下载类目录（展开环境变量后去重，不存在则跳过）。 */
function downloadDirs(): string[] {
  const raw = [
    '%USERPROFILE%\\Downloads',
    '%USERPROFILE%\\Desktop',
    '%USERPROFILE%\\Documents',
    '%USERPROFILE%\\OneDrive\\桌面',
    '%USERPROFILE%\\OneDrive\\文档',
    '%USERPROFILE%\\Downloads\\Programs',
  ]
  const out: string[] = []
  for (const r of raw) {
    const p = expandEnv(r).replace(/\//g, '\\')
    if (!p) continue
    try {
      if (fs.existsSync(p) && !out.includes(p)) out.push(p)
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

/** 判定是否为安装包候选。 */
function isInstallerLike(name: string, size: number): boolean {
  const lower = name.toLowerCase()
  const byName = NAME_HINTS.some((h) => lower.includes(h))
  return byName || size >= BIG_ENOUGH
}

/**
 * 安装包流式扫描。
 * @param minSizeMb 体积下限（MB）
 * @param minDays   存放天数下限
 * @param drive     扫描范围：'' / 'all' = 所有盘符；'C' / 'D'… = 仅该盘符下的下载目录
 */
export async function* scanInstallersStream(
  minSizeMb: number,
  minDays: number,
  isCancelled: () => boolean,
  drive = '',
): AsyncGenerator<InstallerItem[], void, unknown> {
  const minBytes = Math.max(minSizeMb, 0) * 1024 * 1024
  const cutoff = Date.now() - Math.max(minDays, 0) * 86400_000
  // 按盘符过滤下载目录（'' / 'all' 表示全部盘符）
  const allRoots = downloadDirs()
  const roots =
    drive && drive !== 'all'
      ? allRoots.filter((r) => r.toUpperCase().startsWith(drive.toUpperCase() + ':\\'))
      : allRoots

  for (const root of roots) {
    if (isCancelled()) return
    let entries: string[] = []
    try {
      entries = await fg(`**/*.{${EXTS.join(',')}}`, {
        cwd: root,
        onlyFiles: true,
        dot: false,
        absolute: true,
        deep: 3,
        suppressErrors: true,
      })
    } catch {
      continue
    }

    let batch: InstallerItem[] = []
    for (const p of entries) {
      if (isCancelled()) return
      const st = statSafe(p)
      if (!st || !st.isFile()) continue
      if (st.size < minBytes) continue
      if (st.mtimeMs > cutoff) continue
      const name = path.basename(p)
      if (!isInstallerLike(name, st.size)) continue
      batch.push({
        id: hashId(p),
        path: p,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        days: Math.floor((Date.now() - st.mtimeMs) / 86400_000),
        ext: path.extname(p).replace('.', '').toLowerCase(),
        byName: NAME_HINTS.some((h) => name.toLowerCase().includes(h)),
      })
      if (batch.length >= 40) {
        yield batch
        batch = []
        await new Promise((r) => setImmediate(r))
      }
    }
    if (batch.length) {
      yield batch
      await new Promise((r) => setImmediate(r))
    }
  }
}

/** 删除安装包（默认回收站，purge 才永久删除）。 */
export async function deleteInstallers(
  items: Map<string, InstallerItem>,
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
    if (isProtected(it.path)) {
      result.skipped.push({ id, path: it.path, reason: '受保护路径，已拦截' })
      continue
    }
    const st = statSafe(it.path)
    if (!st || !st.isFile()) {
      result.skipped.push({ id, path: it.path, reason: '非文件或已不存在' })
      continue
    }
    try {
      if (purge) fs.unlinkSync(it.path)
      else await moveToRecycleBin(it.path)
      result.deleted_count += 1
      result.deleted_size += st.size
      audit.push({
        id,
        path: it.path,
        size: st.size,
        category: '安装包',
        rule_id: 'installer',
      })
    } catch (e) {
      result.errors.push(`${it.path}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (audit.length) logDeletion(audit, purge)
  return result
}
