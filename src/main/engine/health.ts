/**
 * 一键体检编排（design.md §4 / §9.1 / §9.4）。
 *
 * 编排已有的扫描能力（垃圾 / 重复 / 注册表 / 启动项 / 大文件）+ 新增的磁盘信息 +
 * 社交缓存统计，构造 HealthSnapshot 交给评分引擎，产出 HealthReport。
 * 这是「评分」功能的后端入口，由 IPC `health:scan` 调用。
 */
import * as fs from 'fs'
import * as path from 'path'
import type {
  CleanCandidate,
  RegistryEntry,
  StartupEntry,
  BigFileEntry,
} from './model'
import { scanJunkStream } from './junk'
import { scanDuplicatesStream } from './dup'
import { scanRegistryStream } from './registry'
import { scanStartupStream } from './startup'
import { scanBigFilesStream } from './bigfile'
import { extraJunkItems } from './junk_extra'
import { expandEnv } from './rules'
import { getSystemDiskInfo } from './disk'
import { scanSocialCacheSize } from './social'
import { computeScore, levelOf, type HealthSnapshot } from './score'

const GB = 1024 ** 3

/** 体检结果（含评分与展示用统计）。 */
export interface HealthReport {
  score: number
  level: string
  levelColor: string
  factors: ReturnType<typeof computeScore>['factors']
  suggestions: string[]
  stats: {
    junkBytes: number
    socialBytes: number
    dupBytes: number
    bigfileBytes: number
    registryCount: number
    startupCount: number
    systemFreeGB: number
    systemTotalGB: number
    diskType: string
    diskHealthy: string
    scannedAt: string
  }
}

function isUpdateBacklog(ruleId: string): boolean {
  return (
    ruleId.endsWith(':windows_update_cleanup') ||
    ruleId.endsWith(':delivery_optimization') ||
    ruleId.endsWith(':temp_windows_install')
  )
}

/** 受控目录体积统计（上限防止卡死）。 */
function dirSizeBounded(p: string, maxFiles = 30000): number {
  let total = 0
  let files = 0
  try {
    const st = fs.statSync(p)
    if (st.isFile()) return st.size
    const stack: string[] = [p]
    while (stack.length && files < maxFiles) {
      const cur = stack.pop() as string
      let ents: fs.Dirent[]
      try {
        ents = fs.readdirSync(cur, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of ents) {
        if (files >= maxFiles) break
        const fp = path.join(cur, e.name)
        try {
          if (e.isDirectory()) stack.push(fp)
          else if (e.isFile()) {
            total += fs.statSync(fp).size
            files++
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* not exist */
  }
  return total
}

export async function runHealthScan(
  isCancelled?: () => boolean,
): Promise<HealthReport> {
  const cancel = isCancelled ?? (() => false)
  // Windows.old 体量巨大且递归极慢，体检中不枚举，改为单独受控统计
  const extraIds = extraJunkItems()
    .map((e) => e.id)
    .filter((id) => id !== 'windows_old')

  // 1. 垃圾清理扫描（汇总体积 + 更新积压）
  const junkCands: CleanCandidate[] = []
  for await (const batch of scanJunkStream({ extraIds }, cancel)) {
    junkCands.push(...batch)
  }
  let junkBytes = 0
  let updateBacklogBytes = 0
  for (const c of junkCands) {
    junkBytes += c.size
    if (isUpdateBacklog(c.rule_id)) updateBacklogBytes += c.size
  }

  // 2. 重复文件（可释放体积）
  let dupBytes = 0
  for await (const ev of scanDuplicatesStream({ minMb: 50 }, cancel)) {
    if (ev.type === 'group') dupBytes += ev.group.wasted
  }

  // 3. 注册表冗余项数量
  const regItems: RegistryEntry[] = []
  for await (const batch of scanRegistryStream(cancel)) regItems.push(...batch)
  const registryCount = regItems.length

  // 4. 启动项数量
  const startItems: StartupEntry[] = []
  for await (const batch of scanStartupStream(cancel)) startItems.push(...batch)
  const startupCount = startItems.length

  // 5. 大文件（>200MB）合计
  const big: BigFileEntry[] = []
  for await (const batch of scanBigFilesStream(
    { minSize: 200 * 1024 * 1024, includeAll: false },
    cancel,
  )) {
    big.push(...batch)
  }
  const bigfileBytes = big.reduce((a, b) => a + b.size, 0)

  // 6. 磁盘信息
  const disk = await getSystemDiskInfo()

  // 7. 社交缓存体积（best-effort）
  const social = await scanSocialCacheSize()

  // 8. 可释放系统文件：休眠文件 + 旧 Windows（受控统计）
  let hiberSize = 0
  try {
    hiberSize = fs.statSync(
      path.join(process.env.SystemDrive || 'C:', 'hiberfil.sys'),
    ).size
  } catch {
    hiberSize = 0
  }
  const windowsOldSize = dirSizeBounded(
    expandEnv('%SystemDrive%') + '\\Windows.old',
  )
  const releasableSystemBytes = hiberSize + windowsOldSize

  const snapshot: HealthSnapshot = {
    systemFreeBytes: disk?.freeBytes ?? 0,
    systemTotalBytes: disk?.totalBytes ?? 0,
    junkBytes,
    dupBytes,
    socialBytes: social.totalBytes,
    registryCount,
    startupCount,
    diskType: (disk?.type as HealthSnapshot['diskType']) ?? 'Unknown',
    trimEnabled: disk?.trimEnabled ?? null,
    smartOk: disk?.smartOk ?? null,
    aligned: disk?.aligned ?? null,
    fileSystem: disk?.fileSystem ?? '',
    updateBacklogBytes,
    releasableSystemBytes,
  }

  const result = computeScore(snapshot)
  const level = levelOf(result.score)
  return {
    score: result.score,
    level: result.level,
    levelColor: level.color,
    factors: result.factors,
    suggestions: result.suggestions,
    stats: {
      junkBytes,
      socialBytes: social.totalBytes,
      dupBytes,
      bigfileBytes,
      registryCount,
      startupCount,
      systemFreeGB: (disk?.freeBytes ?? 0) / GB,
      systemTotalGB: (disk?.totalBytes ?? 0) / GB,
      diskType: disk?.type ?? 'Unknown',
      diskHealthy: disk?.healthy ?? '未知',
      scannedAt: new Date().toISOString(),
    },
  }
}
