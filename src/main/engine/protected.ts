import fs from 'fs'
import os from 'os'
import path from 'path'

// 受保护的目录前缀（不区分大小写）。任何位于其下的路径默认禁止删除。
// 注意：系统盘 Windows 目录不在此硬编码，而是运行时按 WINDIR/SystemDrive 动态计算
// （见 systemWindowsDirs），以兼容非 C: 系统盘。
const PROTECTED_PREFIXES: string[] = [
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\$Recycle.Bin',
  'C:\\Recovery',
]

/** 系统盘 Windows 目录（动态取 WINDIR / SystemDrive，兼容非 C: 系统盘）。 */
function systemWindowsDirs(): string[] {
  const dirs = new Set<string>()
  const windir = process.env.WINDIR || process.env.SystemRoot
  if (windir) dirs.add(windir.toLowerCase().replace(/\//g, '\\'))
  const sd = process.env.SystemDrive
  if (sd) dirs.add(path.join(sd, 'Windows').toLowerCase().replace(/\//g, '\\'))
  return [...dirs]
}

// 受保护的单文件（系统关键文件）。
const PROTECTED_EXACT: string[] = [
  'C:\\pagefile.sys',
  'C:\\hiberfil.sys',
  'C:\\swapfile.sys',
  'C:\\bootmgr',
  'C:\\BOOTNXT',
  'C:\\bootnxt',
]

/** 规范化路径：解析符号链接并转小写，用于安全比对。失败（无法解析）时返回 null —— 调用方应视为「受保护」。 */
function canon(p: string): string | null {
  try {
    return fs.realpathSync(p).toLowerCase()
  } catch {
    return null
  }
}

export interface ProtectedOptions {
  /**
   * 本次操作显式放行的系统目录前缀（小写、斜杠或反斜杠分隔均可，内部统一为反斜杠比较）。
   *
   * 用途：系统级清理项（Windows.old、SoftwareDistribution\Download、Minidump 等）
   * 都位于 `C:\Windows` 受保护前缀之下，若不放行会被一律拦截。放行的前提是：
   * ① 用户在界面显式勾选了该清理项；② 候选路径确实落在该项声明的根目录内。
   * 二者缺一不可，避免「一次勾选、全盘放行」。
   */
  allowSystemPrefixes?: string[]
}

/**
 * 纵深防御第一道防线：判断路径是否受保护。
 * 规则（fail-safe：任何无法确认的情况一律按「保护」处理）：
 * 1. 无法规范化（权限不足 / 路径不存在 / 畸形）→ 保护
 * 2. 磁盘根目录（如 `C:\`）→ 保护
 * 3. 系统关键文件精确匹配 → 保护
 * 4. 系统目录前缀匹配 → 保护（除非落在 `allowSystemPrefixes` 显式放行范围内）
 * 5. 用户主目录根（如 `C:\Users\X`）→ 保护（避免整盘用户数据被清）
 * 6. 应用自身所在目录 → 保护（避免自残）
 */
export function isProtected(p: string, opts?: ProtectedOptions): boolean {
  const cp = canon(p)
  if (cp === null) return true
  const s = cp

  const parent = path.dirname(cp)
  // 2. 磁盘根（dirname 返回如 "c:\" 或 ""）
  if (parent === '' || /^[a-z]:\\?$/i.test(parent)) {
    return true
  }

  // 3. 精确系统文件
  for (const exact of PROTECTED_EXACT) {
    if (s === exact.toLowerCase()) return true
  }

  // 4. 系统目录前缀（本次显式放行的前缀内可例外）
  const allow = (opts?.allowSystemPrefixes ?? []).map((a) =>
    a.replace(/\//g, '\\').toLowerCase(),
  )
  const prefixes = [...PROTECTED_PREFIXES, ...systemWindowsDirs()]
  for (const prefix of prefixes) {
    if (!s.startsWith(prefix.toLowerCase())) continue
    // 命中受保护前缀，但路径落在本次显式勾选的清理项目录内 → 放行
    if (allow.some((a) => s.startsWith(a))) continue
    return true
  }

  // 5. 用户主目录根
  const home = canon(os.homedir() ?? '')
  if (home && cp === home) return true

  // 6. 应用自身目录
  try {
    const exeDir = canon(path.dirname(process.execPath))
    if (exeDir && cp.startsWith(exeDir)) return true
  } catch {
    /* ignore */
  }

  return false
}

/**
 * 判断路径是否位于系统盘 Windows 目录下（大小写不敏感，正斜杠/反斜杠均可）。
 * 用途：供扫描阶段提前 `continue` 跳过，避免把系统目录下的文件当作垃圾列出。
 * 与 `isProtected` 的区别：本函数只做「是否落在 Windows 目录」这一项轻量判定，不做
 * 符号链接解析，适合在扫描循环里高频调用；删除保护仍由 `isProtected` 纵深把关。
 */
export function isUnderSystemWindows(p: string): boolean {
  const s = p.toLowerCase().replace(/\//g, '\\')
  return systemWindowsDirs().some((w) => s.startsWith(w))
}
