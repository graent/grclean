import fg from 'fast-glob'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { type CleanCandidate } from './model'
import {
  type JunkRule,
  type UserRule,
  builtinJunkRules,
  loadUserRules,
  expandEnv,
} from './rules'
import { extraItemById, normalizePattern } from './junk_extra'
import { isUnderSystemWindows } from './protected'

/** 每批推送的候选数量（控制 IPC 消息频率，保证丝滑）。 */
const BATCH = 40

/**
 * 外壳/系统标记文件：删除无任何空间收益（体积极小且 Windows 会按需重建），
 * 主流清理工具均默认排除。扫描阶段直接跳过，避免把它们当作普通垃圾列出。
 */
const SYSTEM_MARKER_FILES = new Set([
  'desktop.ini',
  'thumbs.db',
  'ehthumbs.db',
  'ehthumbs_vista.db',
])

/**
 * 系统盘 Windows 目录下「可能影响系统运行与设置」的关键位置（不区分大小写）。
 * 扫描到这些位置下的文件直接跳过，不列入垃圾，避免误清导致系统异常。
 * 其余 Windows 文件（Temp / Logs / Prefetch / SoftwareDistribution\Download /
 * Minidump / Panther 等）仍正常扫描，删除保护由 protected.ts 把关。
 */
const WINDOWS_RISKY_SUBPATHS: string[] = [
  'system32\\config', // 注册表配置单元（删除=系统瘫痪）
  'system32\\catroot', // 编录数据库
  'system32\\catroot2',
  'system32\\drivers', // 设备驱动（驱动清理模块单独处理）
  'system32\\driverstore', // 驱动仓库
  'system32\\wbem', // WMI 脚本库
  'servicing', // CBS 服务栈
  'winsxs', // 组件存储（删除破坏 SxS）
  'boot', // 启动文件
  'system32\\tasks', // 计划任务
  'tasks',
  'system32\\grouppolicy',
  'system32\\grouppolicyusers',
  'grouppolicy',
  'policies',
  'inf', // 安装信息
  'system32\\winevt', // 事件日志仓库
  'system32\\logfiles\\wmi', // WMI 仓库
  'system32\\spool', // 打印后台
  'assembly', // GAC
  'microsoft.net', // .NET 原生映像
  'systemresources', // 主题/资源
  'security', // 安全数据库
  'appcompat', // 兼容性数据库
  'system32\\spp', // 软件保护平台
  'registration', // 组件类注册
]

/** 系统盘 Windows 目录下「可能破坏系统运行」的关键扩展名（内核/驱动/编录）。 */
const WINDOWS_RISKY_EXT = new Set(['.sys', '.cat', '.drv'])

/**
 * 判断文件是否为「系统盘 Windows 目录下、可能影响系统运行与设置」的关键文件。
 * 采用「位置 + 类型」的轻量检测（适合 fast-glob 扫描循环高频调用）：
 * 命中关键子目录或关键扩展名即视为风险文件，跳过不列出。
 * 不做逐文件 Windows 属性（SYSTEM/HIDDEN）查询——那样会为每个文件起子进程，开销不可接受。
 */
function isWindowsRiskyFile(filePath: string): boolean {
  const s = filePath.toLowerCase().replace(/\//g, '\\')
  if (!isUnderSystemWindows(s)) return false
  for (const sub of WINDOWS_RISKY_SUBPATHS) {
    const sep = '\\' + sub + '\\'
    if (s.includes(sep) || s.endsWith('\\' + sub)) return true
  }
  return WINDOWS_RISKY_EXT.has(path.extname(s))
}

/** 由路径生成稳定 id（同一文件每次扫描 id 相同，便于前端维持选择状态）。 */
export function hashId(p: string): string {
  return crypto.createHash('md5').update(p.toLowerCase()).digest('hex')
}

export interface JunkScanOptions {
  /** 指定规则 id 列表；为空表示全部内置规则 + 全部已启用用户规则。 */
  ruleIds?: string[]
  /** 勾选的「增强清理项」id 列表（见 engine/junk_extra.ts）；回收站为特殊项，不走这里。 */
  extraIds?: string[]
}

interface ScanTask {
  category: string
  ruleId: string
  patterns: string[]
  maxAge: number
  minSizeKb: number
}

// 内置规则 → glob 模式（递归用双星号通配，非递归用单星号）。
function rulePatterns(rule: JunkRule): string[] {
  const base = rule.dirs.map((d) => d.replace(/[\\/]+$/, ''))
  return base.map((d) => (rule.recursive ? `${d}/**/*` : `${d}/*`))
}

/** 用户规则 → 展开后的 glob 模式。 */
function userPatterns(rule: UserRule): string[] {
  return rule.paths.map((p) => expandEnv(p))
}

/**
 * 垃圾清理流式扫描（async generator）。
 *
 * 逐规则、逐文件遍历：内置规则用具体目录，用户规则用 glob；fast-glob 的
 * `stream` 是异步 IO，不阻塞主进程事件循环；每收集 `BATCH` 条 yield 一次，
 * 并在每个批次后 `await setImmediate` 让权，使「取消扫描」的 IPC 能立即响应。
 * 每次循环都检查 `isCancelled()` 以便中途中断。
 */
export async function* scanJunkStream(
  opts: JunkScanOptions,
  isCancelled: () => boolean,
): AsyncGenerator<CleanCandidate[], void, unknown> {
  const builtin = builtinJunkRules()
  const user = loadUserRules()
  const selectedBuiltin = opts.ruleIds?.length
    ? builtin.filter((r) => opts.ruleIds!.includes(r.id))
    : builtin
  const selectedUser = opts.ruleIds?.length
    ? user.filter((r) => opts.ruleIds!.includes(r.id))
    : user

  const tasks: ScanTask[] = []
  for (const r of selectedBuiltin) {
    tasks.push({
      category: r.category,
      ruleId: r.id,
      patterns: rulePatterns(r),
      maxAge: r.max_age_days,
      minSizeKb: 0,
    })
  }
  for (const r of selectedUser) {
    if (!r.enabled) continue
    tasks.push({
      category: r.category || r.name,
      ruleId: `user:${r.id}`,
      patterns: userPatterns(r),
      maxAge: r.max_age_days,
      minSizeKb: r.min_size_kb,
    })
  }
  // 增强清理项（前端勾选）：仅加入非特殊项，回收站由主进程单独统计
  for (const id of opts.extraIds ?? []) {
    const item = extraItemById(id)
    if (!item || item.special) continue
    tasks.push({
      category: item.name,
      ruleId: `extra:${item.id}`,
      patterns: item.patterns.map(normalizePattern),
      maxAge: item.max_age_days,
      minSizeKb: 0,
    })
  }

  for (const task of tasks) {
    if (isCancelled()) return
    const stream = fg.stream(task.patterns, {
      onlyFiles: true,
      dot: false,
      suppressErrors: true,
      absolute: true,
    })
    let batch: CleanCandidate[] = []
    for await (const entry of stream) {
      if (isCancelled()) return
      // fast-glob 的 stream() 默认发出匹配项的完整路径字符串（absolute:true 时即绝对路径）
      const filePath = String(entry)
      let st: fs.Stats
      try {
        st = fs.statSync(filePath)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      // 系统盘 Windows 目录：跳过「可能破坏系统运行/设置」的关键文件（位置+类型检测），
      // 其余 Windows 文件（Temp/Logs/Prefetch/更新缓存/内存转储等）仍正常扫描。
      if (isWindowsRiskyFile(filePath)) continue
      // 跳过外壳/系统标记文件（desktop.ini、thumbs.db 等）
      if (SYSTEM_MARKER_FILES.has(path.basename(filePath).toLowerCase())) continue
      const ageDays = Math.floor((Date.now() - st.mtimeMs) / 86400000)
      if (task.maxAge > 0 && ageDays < task.maxAge) continue
      if (task.minSizeKb > 0 && st.size / 1024 < task.minSizeKb) continue
      batch.push({
        id: hashId(filePath),
        path: filePath,
        size: st.size,
        category: task.category,
        rule_id: task.ruleId,
      })
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
