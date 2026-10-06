import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 与后端 engine/model.ts / 前端 api/electron.ts 对应的精简类型（preload 隔离环境内联）
interface CleanCandidate {
  id: string
  path: string
  size: number
  category: string
  rule_id: string
}
interface ScanResult {
  total_count: number
  total_size: number
  categories: Array<{ category: string; count: number; size: number }>
  candidates: CleanCandidate[]
  cancelled: boolean
}
interface CleanResult {
  deleted_count: number
  deleted_size: number
  skipped: Array<{ id: string; path: string; reason: string }>
  errors: string[]
}

interface BigFileEntry {
  path: string
  size: number
}

interface DuplicateFile {
  id: string
  path: string
  size: number
}
interface DuplicateGroup {
  group_id: string
  hash: string
  size: number
  count: number
  wasted: number
  files: DuplicateFile[]
}

interface StartupEntry {
  id: string
  name: string
  command: string
  source: string
  location: string
  enabled: boolean
}

interface UninstallEntry {
  id: string
  name: string
  version: string
  publisher: string
  install_location: string
  size_kb: number
  uninstall_string: string
  quiet_uninstall_string: string
  can_uninstall: boolean
}
interface UninstallResult {
  launched: boolean
  command: string
  error: string | null
}

interface RuleInfo {
  id: string
  name: string
  description: string
  category: string
  enabled: boolean
  source: string
  paths: string[]
  max_age_days: number
}

interface UserRuleInput {
  id: string
  name: string
  category: string
  description: string
  enabled: boolean
  paths: string[]
  max_age_days: number
  min_size_kb: number
}

interface ScheduleConfig {
  id: string
  name: string
  frequency: string
  time: string
  rule_ids: string[]
  enabled: boolean
}

interface PrivacyRuleOption {
  id: string
  name: string
}

interface OkResult {
  ok: boolean
  error: string | null
}

/** 一条无效注册表项。 */
interface RegistryEntry {
  id: string
  category: string
  key_path: string
  name: string
  kind: 'value' | 'key'
  target: string
  detail: string
}
interface RegistryCleanResult {
  deleted_count: number
  skipped: Array<{ id: string; reason: string }>
  errors: string[]
  backup_file: string | null
}
interface RegistryBackup {
  file: string
  created_at: string
  count: number
}

/** 增强清理项（前端勾选用，含风险等级与说明）。 */
interface ExtraJunkItem {
  id: string
  name: string
  description: string
  /** safe | caution | danger */
  level: string
  recommend: boolean
}

/** 社交缓存条目（四级风险：safe / advise / caution / locked）。 */
interface SocialItem {
  id: string
  app: string
  level: string
  name: string
  path: string
  size: number
  fileCount: number
  /** 聊天记录等锁定项：不可勾选、不可删除 */
  locked: boolean
  recommend: boolean
}

/** 语言包摘要（设置页语言下拉用）。 */
interface LocaleMeta {
  /** 语言代码，同时也是文件名（不含 .json） */
  code: string
  name: string
  nativeName: string
  /** 是否为内置播种包 */
  builtin: boolean
  /** 词条数量 */
  count: number
  file: string
}

/** 单个磁盘的结构化信息。 */
interface DiskInfo {
  letter: string
  /** 卷标名称（用户给盘符起的名字，如「系统」「软件」），无则空串 */
  name: string
  fileSystem: string
  totalBytes: number
  freeBytes: number
  type: string
  model: string
  /** SSD Trim 状态；HDD / 未知为 null */
  trimEnabled: boolean | null
  aligned: boolean | null
  smartOk: boolean | null
  healthy: string
  /** 是否为系统盘（%SystemDrive%，通常 C:） */
  system: boolean
}

/** SMART 概览一行：true=正常 / false=异常 / null=未知。 */
interface SmartRow {
  label: string
  value: string
  ok: boolean | null
}

/** 物理磁盘（硬盘本体）。 */
interface PhysicalDiskInfo {
  deviceId: number
  model: string
  type: string
  serial: string
  firmware: string
  busType: string
  sizeBytes: number
  letters: string[]
  totalBytes: number
  freeBytes: number
  smartOk: boolean | null
  healthy: string
  isSystem: boolean
}

/** 安装包条目（§3.7）。 */
interface InstallerItem {
  id: string
  path: string
  size: number
  mtime: number
  days: number
  ext: string
  byName: boolean
}

/** 日志条目（§3.8）：app=应用日志 / temp=临时日志 / crash=崩溃转储与错误报告。 */
interface LogItem {
  id: string
  group: string
  name: string
  path: string
  size: number
  mtime: number
}

/** C 盘瘦身项（§3.12）。 */
interface SlimItem {
  kind: string
  name: string
  desc: string
  size: number
  /** safe / caution / danger */
  risk: string
  recommend: boolean
  /** false = 需跳转对应模块处理 */
  actionable: boolean
  goto?: string
}

/** 右键菜单项（§3.13）。 */
interface ContextMenuItem {
  id: string
  name: string
  verb: string
  source: string
  key: string
  command: string
  system: boolean
  disabled: boolean
}

/** 驱动包条目（§3.14）。 */
interface DriverItem {
  id: string
  name: string
  path: string
  size: number
  infs: string[]
  inUse: boolean
  published: string | null
  className: string
  candidate: boolean
}

/** 卸载残留目录（§3.11）。 */
interface ResidueItem {
  id: string
  name: string
  path: string
  size: number
  mtime: number
  days: number
  source: string
}

/** 可迁移目录（§5.2）。 */
interface MigrateItem {
  id: string
  name: string
  path: string
  size: number
  source: string
  /** 已是目录联接（此前迁移过） */
  isJunction: boolean
}

/** 通用操作结果（禁用/删除/迁移等按条回传）。 */
interface OpResult {
  id: string
  ok: boolean
  message: string
}

/** C 盘瘦身执行结果（按 kind 回传，无 id）。 */
interface SlimOpResult {
  kind: string
  ok: boolean
  message: string
}

/** 外壳图标项（§3.13「此电脑」命名空间扩展）。 */
interface ShellIconItem {
  id: string
  name: string
  guid: string
  source: string
  key: string
  dll: string
  system: boolean
}

/** 磁盘优化项状态（§5.1）。 */
interface OptimizeOption {
  id: string
  title: string
  desc: string
  /** good / warn / bad / unknown */
  status: string
  value: string
  advice: string
  needAdmin: boolean
}

/** 单个优化动作结果。 */
interface OptimizeResult {
  ok: boolean
  message: string
}

/** 可延迟启动的服务（启动加速）。 */
interface DelayableService {
  name: string
  displayName: string
  delayed: boolean
  thirdParty: boolean
}

/** WSL / Docker 占用检测。 */
interface VhdInfo {
  id: string
  title: string
  location: string
  bytes: number
  exists: boolean
  advice: string
}

/** 页面文件状态（§5.3）。 */
interface PagefileInfo {
  autoManaged: boolean
  ramMb: number
  raw: string
  files: Array<{
    drive: string
    initialMb: number
    maxMb: number
    usedMb: number
  }>
  suggestInitialMb: number
  suggestMaxMb: number
  suggestReason: string
}

/** 页面文件可迁移目标盘。 */
interface PagefileTarget {
  letter: string
  freeBytes: number
  totalBytes: number
}

/** 系统还原点状态（§3.9）。 */
interface RestoreStatus {
  enabled: boolean
  systemVolume: string
  storage: Array<{ volume: string; maxMb: number; usedMb: number }>
  points: Array<{ seq: number; description: string; time: string; type: string }>
  totalUsedMb: number
}

/** 目录树节点（大目录钻取）。 */
interface TreeNode {
  path: string
  name: string
  size: number
  fileCount: number
  dirCount: number
  children: TreeNode[]
}

/** 大目录钻取进度。 */
interface AnalyzeProgress {
  dirs: number
  files: number
  bytes: number
  current: string
}

/** 容量快照。 */
interface Snapshot {
  id: string
  ts: number
  time: string
  volumes: Array<{ letter: string; totalBytes: number; freeBytes: number }>
  dirs: Array<{ path: string; bytes: number }>
}

/** 两次快照对比结果。 */
interface SnapshotDiff {
  base: Snapshot
  target: Snapshot
  volumes: Array<{ letter: string; usedBefore: number; usedAfter: number; delta: number }>
  dirs: Array<{ path: string; before: number; after: number; delta: number; isNew: boolean }>
  totalDelta: number
  days: number
}

/** 一条评分因素结果。 */
interface FactorResult {
  key: string
  label: string
  weight: number
  score: number
  max: number
  detail: string
}

/** 一键体检报告。 */
interface HealthReport {
  score: number
  level: string
  levelColor: string
  factors: FactorResult[]
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

/** 一条扫描记录（上次扫描时间 + 结果摘要）。 */
interface ScanRecord {
  module: string
  scannedAt: number
  summary: string
}

// ---------------------------------------------------------------------------
// 垃圾清理流式封装
//
// 前端传入 `onItem` 回调，主进程在扫描过程中以「批」为单位持续推送候选，
// 主进程扫描结束（或取消）时 resolve 权威结果。等价于 Tauri 的 Channel 语义，
// 但天然跨进程、且主进程用 async 遍历 + 分批让出，UI 永不卡顿。
// ---------------------------------------------------------------------------
/**
 * 垃圾清理流式扫描。
 * @param extraIds 勾选的「增强清理项」id 列表（见 engine/junk_extra.ts）
 */
function scanJunk(
  extraIds: string[],
  onItem: (item: CleanCandidate) => void,
): Promise<ScanResult> {
  return new Promise<ScanResult>((resolve, reject) => {
    const channel = 'scan-junk'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as CleanCandidate[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as ScanResult)
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-junk:start', { extraIds })
  })
}

// 大文件分析流式封装（与 scanJunk 同构，仅分析不删除）
// scope：''=用户目录；'all'=全部盘符；'C'/'D'…=指定盘符
function scanBigFiles(
  minMb: number,
  scope: string,
  onItem: (item: BigFileEntry) => void,
): Promise<BigFileEntry[]> {
  return new Promise<BigFileEntry[]>((resolve, reject) => {
    const channel = 'scan-bigfiles'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as BigFileEntry[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as BigFileEntry[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-bigfiles:start', {
      minMb,
      includeAll: scope === 'all',
      drive: scope !== '' && scope !== 'all' ? scope : undefined,
    })
  })
}

// 重复文件流式封装：逐组回调（group）+ 哈希进度（progress）
function scanDuplicates(
  minMb: number,
  onGroup: (g: DuplicateGroup) => void,
  onProgress: (n: number) => void,
  drive?: string,
): Promise<DuplicateGroup[]> {
  return new Promise<DuplicateGroup[]>((resolve, reject) => {
    const channel = 'scan-duplicates'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'group') {
        onGroup(payload.group as DuplicateGroup)
      } else if (payload.type === 'progress') {
        onProgress(payload.n as number)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as DuplicateGroup[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-duplicates:start', { minMb, drive: drive ?? '' })
  })
}

// 启动项流式封装（收集完成后分批推送，逐条回调给前端）
function scanStartup(
  onItem: (item: StartupEntry) => void,
): Promise<StartupEntry[]> {
  return new Promise<StartupEntry[]>((resolve, reject) => {
    const channel = 'scan-startup'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as StartupEntry[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as StartupEntry[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-startup:start')
  })
}

// 注册表清理流式封装
function scanRegistry(
  onItem: (item: RegistryEntry) => void,
): Promise<RegistryEntry[]> {
  return new Promise<RegistryEntry[]>((resolve, reject) => {
    const channel = 'scan-registry'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as RegistryEntry[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as RegistryEntry[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-registry:start')
  })
}

// 已安装程序流式封装
function scanUninstall(
  onItem: (item: UninstallEntry) => void,
): Promise<UninstallEntry[]> {
  return new Promise<UninstallEntry[]>((resolve, reject) => {
    const channel = 'scan-uninstall'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as UninstallEntry[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as UninstallEntry[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-uninstall:start')
  })
}

// 社交缓存流式封装（按应用分批产出）
function scanSocial(onItem: (item: SocialItem) => void): Promise<SocialItem[]> {
  return new Promise<SocialItem[]>((resolve, reject) => {
    const channel = 'scan-social'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as SocialItem[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as SocialItem[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-social:start')
  })
}

// 安装包清理流式封装
function scanInstallers(
  minSizeMb: number,
  minDays: number,
  drive: string,
  onItem: (item: InstallerItem) => void,
): Promise<InstallerItem[]> {
  return new Promise<InstallerItem[]>((resolve, reject) => {
    const channel = 'scan-installers'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as InstallerItem[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as InstallerItem[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-installers:start', { minSizeMb, minDays, drive })
  })
}

// 日志清理流式封装
function scanLogs(
  minDays: number,
  drive: string,
  onItem: (item: LogItem) => void,
): Promise<LogItem[]> {
  return new Promise<LogItem[]>((resolve, reject) => {
    const channel = 'scan-logs'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as LogItem[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as LogItem[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-logs:start', { minDays, drive })
  })
}

// 卸载残留流式封装
function scanResidue(
  minSizeMb: number,
  minDays: number,
  onItem: (item: ResidueItem) => void,
): Promise<ResidueItem[]> {
  return new Promise<ResidueItem[]>((resolve, reject) => {
    const channel = 'scan-residue'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as ResidueItem[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as ResidueItem[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('scan-residue:start', { minSizeMb, minDays })
  })
}

// 驱动包流式封装
function scanDriversStream(
  onItem: (item: DriverItem) => void,
  onProgress?: (scanned: number, total: number) => void,
): Promise<{ items: DriverItem[]; note: string }> {
  return new Promise<{ items: DriverItem[]; note: string }>((resolve, reject) => {
    const channel = 'drivers:scan'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        console.log('[preload] drivers:scan item count=' + (payload.items?.length ?? 0))
        for (const it of payload.items as DriverItem[]) onItem(it)
      } else if (payload.type === 'progress') {
        onProgress?.(payload.scanned ?? 0, payload.total ?? 0)
      } else if (payload.type === 'done') {
        console.log('[preload] drivers:scan done result=' + (payload.result?.length ?? 0))
        ipcRenderer.removeListener(channel, handler)
        resolve({ items: payload.result as DriverItem[], note: payload.note ?? '' })
      } else if (payload.type === 'error') {
        console.log('[preload] drivers:scan error: ' + payload.message)
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    console.log('[preload] send drivers:scan:start')
    ipcRenderer.send('drivers:scan:start')
  })
}

// 可迁移目录流式封装
function listMigratableStream(
  minMb: number,
  onItem: (item: MigrateItem) => void,
): Promise<MigrateItem[]> {
  return new Promise<MigrateItem[]>((resolve, reject) => {
    const channel = 'migrate:list'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as MigrateItem[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as MigrateItem[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('migrate:list:start', { minMb })
  })
}

// 右键菜单流式封装
function scanContextMenuStream(
  onItem: (item: ContextMenuItem) => void,
): Promise<ContextMenuItem[]> {
  return new Promise<ContextMenuItem[]>((resolve, reject) => {
    const channel = 'ctx:scan'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as ContextMenuItem[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as ContextMenuItem[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('ctx:scan:start')
  })
}

// 外壳图标流式封装
function scanShellIconsStream(
  onItem: (item: ShellIconItem) => void,
): Promise<ShellIconItem[]> {
  return new Promise<ShellIconItem[]>((resolve, reject) => {
    const channel = 'icons:scan'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload.type === 'item') {
        for (const it of payload.items as ShellIconItem[]) onItem(it)
      } else if (payload.type === 'done') {
        ipcRenderer.removeListener(channel, handler)
        resolve(payload.result as ShellIconItem[])
      } else if (payload.type === 'error') {
        ipcRenderer.removeListener(channel, handler)
        reject(new Error(payload.message))
      }
    }
    ipcRenderer.on(channel, handler)
    ipcRenderer.send('icons:scan:start')
  })
}

// Custom APIs for renderer
const api = {
  scanJunk,
  scanBigFiles,
  scanDuplicates,
  scanStartup,
  scanUninstall,
  scanRegistry,
  scanSocial,
  scanInstallers,
  scanLogs,
  scanResidue,
  cancelScan(): void {
    ipcRenderer.send('scan-junk:cancel')
  },
  uninstall(id: string, quiet: boolean): Promise<UninstallResult> {
    return ipcRenderer.invoke('uninstall', { id, quiet })
  },
  setStartupEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error: string | null }> {
    return ipcRenderer.invoke('set-startup-enabled', { id, enabled })
  },
  deleteDuplicates(ids: string[], purge: boolean): Promise<CleanResult> {
    return ipcRenderer.invoke('delete-duplicates', { ids, purge })
  },
  listExtraJunk(): Promise<ExtraJunkItem[]> {
    return ipcRenderer.invoke('list-extra-junk')
  },
  deleteRegistry(ids: string[]): Promise<RegistryCleanResult> {
    return ipcRenderer.invoke('delete-registry', ids)
  },
  listRegistryBackups(): Promise<RegistryBackup[]> {
    return ipcRenderer.invoke('list-registry-backups')
  },
  restoreRegistry(
    file: string,
  ): Promise<{ restored: number; errors: string[] }> {
    return ipcRenderer.invoke('restore-registry', file)
  },
  // 清理规则
  listRules(): Promise<RuleInfo[]> {
    return ipcRenderer.invoke('list-rules')
  },
  addUserRule(rule: UserRuleInput): Promise<OkResult> {
    return ipcRenderer.invoke('add-user-rule', rule)
  },
  deleteUserRule(id: string): Promise<OkResult> {
    return ipcRenderer.invoke('delete-user-rule', id)
  },
  getRulesDir(): Promise<string> {
    return ipcRenderer.invoke('get-rules-dir')
  },
  openRulesDir(): Promise<void> {
    return ipcRenderer.invoke('open-rules-dir')
  },
  // 定时清理
  listSchedules(): Promise<ScheduleConfig[]> {
    return ipcRenderer.invoke('list-schedules')
  },
  addSchedule(cfg: ScheduleConfig): Promise<OkResult> {
    return ipcRenderer.invoke('add-schedule', cfg)
  },
  deleteSchedule(id: string): Promise<OkResult> {
    return ipcRenderer.invoke('delete-schedule', id)
  },
  listPrivacyRules(): Promise<PrivacyRuleOption[]> {
    return ipcRenderer.invoke('list-privacy-rules')
  },
  runPrivacyNow(ruleIds: string[] | null): Promise<CleanResult> {
    return ipcRenderer.invoke('run-privacy-now', ruleIds)
  },
  clean(
    ids: string[] | null,
    purge: boolean,
    onProgress?: (ev: { type: 'items'; ids: string[] }) => void,
  ): Promise<CleanResult> {
    // 清理过程进度：主进程每删完（一批）即推送已删除项 id，
    // 前端实时移除列表项并累计计数；invoke 结束后自动移除监听。
    const channel = 'clean:progress'
    const handler = (_e: IpcRendererEvent, payload: any) => {
      if (payload?.type === 'items') onProgress?.(payload)
    }
    if (onProgress) ipcRenderer.on(channel, handler)
    return ipcRenderer
      .invoke('clean', { ids, purge })
      .finally(() => {
        if (onProgress) ipcRenderer.removeListener(channel, handler)
      })
  },
  getVersion(): Promise<string> {
    return ipcRenderer.invoke('app:version')
  },
  /** force=true 时忽略缓存重新采集；否则优先返回上次结果（磁盘缓存）。 */
  getSystemInfo(force?: boolean): Promise<{
    os: string
    arch: string
    processor: string
    cpuCores: number
    cpuThreads: number
    cpuGHz: number
    memTotalGB: number
    memFreeGB: number
    computerName: string
    user: string
    updatedAt: number
  }> {
    return ipcRenderer.invoke('get-system-info', force === true)
  },
  // 多语言：语言包为 JSON 文件，运行中可热增减
  listLocales(): Promise<LocaleMeta[]> {
    return ipcRenderer.invoke('i18n:list')
  },
  getLocaleMessages(code: string): Promise<Record<string, string>> {
    return ipcRenderer.invoke('i18n:get', { code })
  },
  getI18nDir(): Promise<string> {
    return ipcRenderer.invoke('i18n:dir')
  },
  openI18nDir(): Promise<void> {
    return ipcRenderer.invoke('i18n:open-dir')
  },
  // 扫描记录：每模块最近一次扫描的时间 + 结果摘要（JSON 文件存储）
  getScanHistory(module: string): Promise<ScanRecord | null> {
    return ipcRenderer.invoke('history:get', { module })
  },
  recordScanHistory(module: string, summary: string): Promise<ScanRecord> {
    return ipcRenderer.invoke('history:record', { module, summary })
  },
  // 一键体检：编排各扫描 + 评分，返回完整报告
  healthScan(): Promise<HealthReport> {
    return ipcRenderer.invoke('health:scan')
  },
  // 社交缓存：取消扫描 / 清理选中项
  cancelScanSocial(): void {
    ipcRenderer.send('scan-social:cancel')
  },
  deleteSocial(ids: string[], purge: boolean): Promise<CleanResult> {
    return ipcRenderer.invoke('delete-social', { ids, purge })
  },
  // 大文件 / 单文件：删除（默认移入回收站），按路径操作，不走清理会话
  deleteOne(path: string): Promise<{ ok: boolean; error: string | null }> {
    return ipcRenderer.invoke('delete-one', { path })
  },
  // 磁盘信息分析
  listDisks(): Promise<DiskInfo[]> {
    return ipcRenderer.invoke('disk:list')
  },
  listPhysicalDisks(): Promise<PhysicalDiskInfo[]> {
    return ipcRenderer.invoke('disk:physical')
  },
  smartOverview(deviceId: number): Promise<SmartRow[]> {
    return ipcRenderer.invoke('disk:smart', { deviceId })
  },
  diskInfo(letter: string): Promise<DiskInfo | null> {
    return ipcRenderer.invoke('disk:info', { letter })
  },
  // 安装包清理
  cancelScanInstallers(): void {
    ipcRenderer.send('scan-installers:cancel')
  },
  deleteInstallers(ids: string[], purge: boolean): Promise<CleanResult> {
    return ipcRenderer.invoke('delete-installers', { ids, purge })
  },
  // 日志清理
  cancelScanLogs(): void {
    ipcRenderer.send('scan-logs:cancel')
  },
  deleteLogs(ids: string[], purge: boolean): Promise<CleanResult> {
    return ipcRenderer.invoke('delete-logs', { ids, purge })
  },
  // C 盘瘦身
  slimPlan(): Promise<SlimItem[]> {
    return ipcRenderer.invoke('slim:plan')
  },
  slimRun(kinds: string[]): Promise<SlimOpResult[]> {
    return ipcRenderer.invoke('slim:run', { kinds })
  },
  // 右键菜单
  scanContextMenu: scanContextMenuStream,
  setContextMenuDisabled(ids: string[], disabled: boolean): Promise<OpResult[]> {
    return ipcRenderer.invoke('ctx:set-disabled', { ids, disabled })
  },
  deleteContextMenu(ids: string[]): Promise<OpResult[]> {
    return ipcRenderer.invoke('ctx:delete', { ids })
  },
    ctxBackupDir(): Promise<string> {
      return ipcRenderer.invoke('ctx:backup-dir')
    },
    /** 在资源管理器中打开某文件 / 目录所在的目录（扫描结果一键定位）。 */
    openPath(path: string): Promise<{ ok: boolean; error: string | null }> {
      return ipcRenderer.invoke('open-path', { path })
    },
  // 卸载残留
  cancelScanResidue(): void {
    ipcRenderer.send('scan-residue:cancel')
  },
  deleteResidue(ids: string[], purge: boolean): Promise<CleanResult> {
    return ipcRenderer.invoke('delete-residue', { ids, purge })
  },
  // 驱动清理
  scanDrivers: scanDriversStream,
  deleteDrivers(ids: string[]): Promise<OpResult[]> {
    return ipcRenderer.invoke('drivers:delete', { ids })
  },
  // 软件数据迁移
  listMigratable: listMigratableStream,
  listMigrateTargets(): Promise<
    Array<{ letter: string; freeBytes: number; totalBytes: number }>
  > {
    return ipcRenderer.invoke('migrate:targets')
  },
  migrateDirectory(id: string, targetRoot: string): Promise<OpResult> {
    return ipcRenderer.invoke('migrate:run', { id, targetRoot })
  },
  restoreDirectory(id: string): Promise<OpResult> {
    return ipcRenderer.invoke('migrate:restore', { id })
  },
  // 外壳图标（此电脑）
  scanShellIcons: scanShellIconsStream,
  deleteShellIcons(ids: string[]): Promise<OpResult[]> {
    return ipcRenderer.invoke('icons:delete', { ids })
  },
  // 磁盘优化（§5.1）
  optStatus(letter: string): Promise<OptimizeOption[]> {
    return ipcRenderer.invoke('opt:status', { letter })
  },
  optSetTrim(enable: boolean): Promise<OptimizeResult> {
    return ipcRenderer.invoke('opt:trim', { enable })
  },
  optDefrag(letter: string, analyze: boolean): Promise<OptimizeResult> {
    return ipcRenderer.invoke('opt:defrag', { letter, analyze })
  },
  optOpenStorageSense(): Promise<OptimizeResult> {
    return ipcRenderer.invoke('opt:storagesense-open')
  },
  optRunStorageSense(): Promise<OptimizeResult> {
    return ipcRenderer.invoke('opt:storagesense-run')
  },
  optSetCompactOs(enable: boolean): Promise<OptimizeResult> {
    return ipcRenderer.invoke('opt:compactos', { enable })
  },
  // 启动加速（§5.3）
  optServices(): Promise<DelayableService[]> {
    return ipcRenderer.invoke('opt:services')
  },
  optSetServiceDelayed(name: string, delayed: boolean): Promise<OptimizeResult> {
    return ipcRenderer.invoke('opt:service-delayed', { name, delayed })
  },
  // WSL / Docker 检测
  optVhd(): Promise<VhdInfo[]> {
    return ipcRenderer.invoke('opt:vhd')
  },
  // 虚拟内存（§5.3）
  pfInfo(): Promise<PagefileInfo> {
    return ipcRenderer.invoke('pf:info')
  },
  pfTargets(): Promise<PagefileTarget[]> {
    return ipcRenderer.invoke('pf:targets')
  },
  pfApply(
    mode: string,
    letter: string,
    initialMb: number,
    maxMb: number,
  ): Promise<OptimizeResult> {
    return ipcRenderer.invoke('pf:apply', { mode, letter, initialMb, maxMb })
  },
  // 系统还原点（§3.9 / §5.3）
  rpStatus(): Promise<RestoreStatus> {
    return ipcRenderer.invoke('rp:status')
  },
  rpDeleteOld(keep: number): Promise<OptimizeResult> {
    return ipcRenderer.invoke('rp:delete-old', { keep })
  },
  rpSetMax(pct: number): Promise<OptimizeResult> {
    return ipcRenderer.invoke('rp:set-max', { pct })
  },
  rpSetProtection(enable: boolean): Promise<OptimizeResult> {
    return ipcRenderer.invoke('rp:set-protection', { enable })
  },
  // 大目录钻取（§5.3）
  tmRoots(): Promise<Array<{ label: string; path: string }>> {
    return ipcRenderer.invoke('tm:roots')
  },
  tmAnalyze(root: string, depth: number): Promise<TreeNode> {
    return ipcRenderer.invoke('tm:analyze', { root, depth })
  },
  tmCancel(): void {
    ipcRenderer.send('tm:cancel')
  },
  onTreemapProgress(cb: (p: AnalyzeProgress) => void): () => void {
    const handler = (_e: IpcRendererEvent, p: AnalyzeProgress) => cb(p)
    ipcRenderer.on('tm:progress', handler)
    return () => ipcRenderer.removeListener('tm:progress', handler)
  },
  // 磁盘空间变化分析（§5.3）
  snapTake(root?: string): Promise<Snapshot> {
    return ipcRenderer.invoke('snap:take', { root })
  },
  snapList(): Promise<Snapshot[]> {
    return ipcRenderer.invoke('snap:list')
  },
  snapDelete(id: string): Promise<boolean> {
    return ipcRenderer.invoke('snap:delete', { id })
  },
  snapDiff(baseId: string, targetId: string): Promise<SnapshotDiff | null> {
    return ipcRenderer.invoke('snap:diff', { baseId, targetId })
  },
  snapCancel(): void {
    ipcRenderer.send('snap:cancel')
  },
  // 远程：更新检查 / 社区信息（捐赠 + 群聊）/ 反馈提交（均带本地示例回退）
  checkUpdate(): Promise<{
    current: string
    latest: string
    hasUpdate: boolean
    url: string
    notes: string[]
    source: 'remote' | 'sample'
    checkedAt: number
  }> {
    return ipcRenderer.invoke('check-update')
  },
  fetchCommunity(): Promise<{
    donations: Array<{
      name: string
      amount: number
      date: string
      message?: string
      method?: string
    }>
    groups: Array<{
      type: string
      name: string
      link?: string
      qr?: string
      note?: string
      hidden?: boolean
    }>
    feedbacks: Array<{ name?: string; content: string; date: string; reply?: string }>
    qrs: Array<{
      platform: string
      url: string
      sha256: string
      payee?: string
      account?: string
    }>
  }> {
    return ipcRenderer.invoke('fetch-community')
  },
  fetchDonateQr(platform: string): Promise<{
    ok: boolean
    platform: string
    dataUrl?: string
    payee?: string
    account?: string
    message: string
  }> {
    return ipcRenderer.invoke('fetch-donate-qr', platform)
  },
  submitFeedback(payload: {
    name?: string
    type?: string
    contact?: string
    content: string
  }): Promise<{ ok: boolean; demo: boolean; message: string }> {
    return ipcRenderer.invoke('submit-feedback', payload)
  },
  /**
   * 程序完整性校验：本机程序文件哈希 vs 官方发布值（需联网）。
   * platform 无关；返回英文结果码由界面按 i18n 映射。
   */
  verifyIntegrity(): Promise<{
    code: string
    version: string
    msg: string
    files: Array<{
      name: string
      size: number
      local: string
      match: boolean | null
    }>
    checkedAt: number
  }> {
    return ipcRenderer.invoke('verify-integrity')
  },
  /** 用系统默认浏览器打开 http(s) 外链。 */
  openExternal(url: string): Promise<boolean> {
    return ipcRenderer.invoke('open-external', url)
  },
  windowControls: {
    minimize(): void {
      ipcRenderer.send('window:minimize')
    },
    close(): void {
      ipcRenderer.send('window:close')
    },
    /** 切换窗口置顶，返回切换后的状态。 */
    toggleAlwaysOnTop(): Promise<boolean> {
      return ipcRenderer.invoke('window:toggle-always-on-top')
    },
    /** 读取当前置顶状态。 */
    isAlwaysOnTop(): Promise<boolean> {
      return ipcRenderer.invoke('window:is-always-on-top')
    },
  },
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
