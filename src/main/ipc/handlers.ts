import { type BrowserWindow, app, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { type CleanCandidate, type CleanResult, type ScanResult, type CategorySummary } from '../engine/model'
import { appState } from '../engine/state'
import { scanJunkStream } from '../engine/junk'
import { scanBigFilesStream } from '../engine/bigfile'
import { scanDuplicatesStream } from '../engine/dup'
import { scanStartupStream, setStartupEnabled } from '../engine/startup'
import { scanUninstallStream, uninstallProgram } from '../engine/uninstall'
import { listLocales, getMessages, i18nDir, type LocaleMeta } from '../engine/i18n'
import {
  getUpdateInfo,
  getCommunity,
  submitFeedback,
  fetchDonateQr,
  verifyIntegrity,
  type DonateQrResult,
} from '../engine/remote'
import {
  type UserRule,
  builtinJunkRules,
  loadUserRules,
  saveUserRule,
  deleteUserRule as deleteUserRuleFile,
  rulesDir,
} from '../engine/rules'
import {
  listSchedules,
  addSchedule,
  removeSchedule,
  privacyRuleOptions,
  runPrivacyCleanup,
} from '../engine/schedule'
import { deleteCandidates } from '../engine/delete'
import { logDeletion, logUninstall } from '../engine/audit'
import { recycleBinList, deleteRecycleEntries } from '../engine/recycle'
import { moveToRecycleBin } from '../engine/trash-bin'
import {
  scanRegistryStream,
  deleteRegistryEntries,
  listBackups,
  restoreBackup,
} from '../engine/registry'
import {
  extraJunkItems,
  extraItemById,
  isSystemExtra,
  extraRootPrefixes,
} from '../engine/junk_extra'
import { runHealthScan, type HealthReport } from '../engine/health'
import {
  scanSocialStream,
  deleteSocialItems,
  LEVEL_META,
  type SocialItem,
} from '../engine/social'
import {
  getAllDiskInfo,
  getDiskInfoByLetter,
  getPhysicalDisks,
  getSmartOverview,
  type DiskInfo,
  type PhysicalDiskInfo,
  type SmartRow,
} from '../engine/disk'
import {
  scanInstallersStream,
  deleteInstallers,
  type InstallerItem,
} from '../engine/installer'
import {
  scanLogsStream,
  deleteLogs,
  LOG_GROUP_META,
  type LogItem,
} from '../engine/logs'
import { slimPlan, runSlim, type SlimItem, type SlimKind } from '../engine/slim'
import {
  scanContextMenuStream,
  setContextMenuDisabled,
  deleteContextMenu,
  scanShellIconsStream,
  deleteShellIcons,
  backupDir as ctxBackupDir,
  type ContextMenuItem,
  type ShellIconItem,
} from '../engine/contextmenu'
import {
  getOptimizeStatus,
  setTrimEnabled,
  runDefrag,
  runStorageSenseNow,
  setCompactOs,
  listDelayableServices,
  setServiceDelayed,
  detectVhd,
  type OptimizeOption,
  type OptimizeResult,
  type DelayableService,
  type VhdInfo,
} from '../engine/optimize'
import {
  getPagefileInfo,
  listPagefileTargets,
  applyPagefile,
  type PagefileInfo,
  type PagefileTarget,
  type PagefileApplyResult,
} from '../engine/pagefile'
import {
  getRestoreStatus,
  deleteOldRestorePoints,
  setRestoreMaxPercent,
  setSystemProtection,
  type RestoreStatus,
  type RestoreResult,
} from '../engine/restore'
import {
  analyzeDirectory,
  defaultRoots,
  type TreeNode,
  type AnalyzeProgress,
} from '../engine/treemap'
import {
  takeSnapshot,
  listSnapshots,
  deleteSnapshot,
  diffSnapshots,
  type Snapshot,
  type SnapshotDiff,
} from '../engine/snapshot'
import { scanDriversStream, deleteDrivers, getLastDriverDiag, type DriverItem } from '../engine/drivers'
import { scanResidueStream, deleteResidue, type ResidueItem } from '../engine/residue'
import { getSystemInfo, type SystemInfo } from '../engine/sysinfo'
import { getScanRecord, recordScan } from '../engine/history'
import {
  listMigratableStream,
  listTargetRoots,
  migrateDirectory,
  restoreDirectory,
  type MigrateItem,
} from '../engine/migrate'

function emptyResult(): import('../engine/model').CleanResult {
  return { deleted_count: 0, deleted_size: 0, skipped: [], errors: [] }
}

/**
 * 收集本次允许放行的系统目录前缀。
 *
 * 仅当候选来自「前端显式勾选的系统级增强清理项」时才加入，
 * 且放行范围严格限定在该项声明的根目录（`extraRootPrefixes`），
 * 因此勾选「Windows 更新清理」不会连带放行 `C:\Windows\System32`。
 */
function collectAllowSystemPrefixes(
  candidates: Map<string, import('../engine/model').CleanCandidate>,
  ids: string[] | null,
): string[] {
  const list = ids
    ? ids.map((id) => candidates.get(id)).filter((c) => !!c)
    : Array.from(candidates.values())
  const set = new Set<string>()
  for (const c of list) {
    if (!c || !c.rule_id.startsWith('extra:')) continue
    const item = extraItemById(c.rule_id.slice('extra:'.length))
    if (!item || !isSystemExtra(item)) continue
    for (const r of extraRootPrefixes(item)) set.add(r)
  }
  return Array.from(set)
}

/**
 * 根据候选列表构建最终扫描结果（分类汇总 + 总量）。
 * `scannedCategories` 为本轮实际扫描到的分类有序列表（内置规则 + 已勾选增强项 + 回收站），
 * 即使某分类扫描结果为 0 也会列出（满足「所有分类都显示，结果为 0 条即可」）。
 */
function buildScanResult(
  candidates: CleanCandidate[],
  cancelled: boolean,
  scannedCategories: string[],
): ScanResult {
  const m = new Map<string, CategorySummary>()
  for (const c of candidates) {
    const e = m.get(c.category) ?? { category: c.category, count: 0, size: 0 }
    e.count += 1
    e.size += c.size
    m.set(c.category, e)
  }
  const present = new Set(m.keys())
  // 先把所有已扫描分类放进去（0 条也列出），再追加候选中出现但未登记的（理论上不会发生）
  const ordered: CategorySummary[] = []
  for (const cat of scannedCategories) {
    ordered.push(m.get(cat) ?? { category: cat, count: 0, size: 0 })
  }
  for (const [cat, e] of m) {
    if (!present.has(cat)) continue
    if (!scannedCategories.includes(cat)) ordered.push(e)
  }
  const totalSize = candidates.reduce((s, c) => s + c.size, 0)
  return {
    total_count: candidates.length,
    total_size: totalSize,
    categories: ordered,
    candidates,
    cancelled,
  }
}

/**
 * 注册所有 IPC 处理（在主窗口创建后调用）。
 *
 * 流式机制：前端 `scan-junk:start` 触发 → 主进程用 async generator 逐批扫描，
 * 每批经 `webContents.send('scan-junk', {type:'item', items})` 推送；结束时发送
 * `done`（含权威结果），异常时发送 `error`。前端取消则置 `appState.cancel`，
 * 扫描循环在批次间轮询中断。
 */
export function registerHandlers(win: BrowserWindow): void {
  // 垃圾清理：开始流式扫描
  ipcMain.on(
    'scan-junk:start',
    async (_e, payload: { extraIds?: string[] } | undefined) => {
      appState.resetCancel()
      const extraIds = payload?.extraIds ?? []
      const candidates: CleanCandidate[] = []
      try {
        for await (const batch of scanJunkStream(
          { extraIds },
          () => appState.cancel,
        )) {
          win.webContents.send('scan-junk', { type: 'item', items: batch })
          candidates.push(...batch)
        }

        // 回收站：作为「增强清理项」可选勾选；勾选时才逐条扫描当前用户所有本地盘的回收站，
        // 逐条列出（可单独删除 / 整组勾选清空），不走普通文件删除流程。
        if (!appState.cancel && extraIds.includes('recycle_bin')) {
          const entries = await recycleBinList()
          if (entries.length) {
            const items: CleanCandidate[] = entries.map((e) => ({
              id: e.id,
              path: `${e.name}${e.originalDir ? `（原位置：${e.originalDir}）` : ''}`,
              size: e.size,
              category: '回收站',
              rule_id: 'recycle',
            }))
            win.webContents.send('scan-junk', { type: 'item', items })
            candidates.push(...items)
            appState.setItemSession('recycleSession', entries)
          }
        }
      } catch (e) {
        win.webContents.send('scan-junk', {
          type: 'error',
          message: String(e instanceof Error ? e.message : e),
        })
        return
      }
      const cancelled = appState.cancel
      appState.setSession(candidates)
      // 本轮回溯的全部分类（即使 0 条也列出）：内置规则 + 已勾选增强项 + 回收站（若勾选）
      const scannedCategories: string[] = []
      const seenCat = new Set<string>()
      const addCat = (c: string) => {
        if (!seenCat.has(c)) {
          seenCat.add(c)
          scannedCategories.push(c)
        }
      }
      for (const r of builtinJunkRules()) addCat(r.category)
      for (const id of extraIds) {
        const item = extraItemById(id)
        if (item) addCat(item.name)
      }
      win.webContents.send('scan-junk', {
        type: 'done',
        result: buildScanResult(candidates, cancelled, scannedCategories),
      })
    },
  )

  // 取消正在进行的扫描（垃圾清理 / 大文件共用同一取消标志）
  ipcMain.on('scan-junk:cancel', () => {
    appState.cancel = true
  })

  // 大文件分析：开始流式扫描（仅分析，不涉及删除）
  ipcMain.on(
    'scan-bigfiles:start',
    async (_e, payload: { minMb: number; includeAll: boolean; drive?: string }) => {
      appState.resetCancel()
      const all: import('../engine/model').BigFileEntry[] = []
      try {
        for await (const batch of scanBigFilesStream(
          {
            minSize: Math.max(payload.minMb, 1) * 1024 * 1024,
            includeAll: payload.includeAll,
            drive: payload.drive,
          },
          () => appState.cancel,
        )) {
          win.webContents.send('scan-bigfiles', { type: 'item', items: batch })
          all.push(...batch)
        }
      } catch (err) {
        win.webContents.send('scan-bigfiles', {
          type: 'error',
          message: String(err instanceof Error ? err.message : err),
        })
        return
      }
      // 完成：按大小降序发权威结果（前端用其覆盖累加列表）
      all.sort((a, b) => b.size - a.size)
      win.webContents.send('scan-bigfiles', { type: 'done', result: all })
    },
  )

  // 执行清理（七道防线：会话反查 + 受保护拦截 + 仅文件 + 回收站/永久删除 + 审计）
  ipcMain.handle(
    'clean',
    async (
      _e,
      payload: { ids: string[] | null; purge: boolean },
    ): Promise<CleanResult> => {
      const session = appState.session
      if (!session) {
        return {
          deleted_count: 0,
          deleted_size: 0,
          skipped: [],
          errors: ['没有可清理的扫描结果，请先执行扫描'],
        }
      }

      const allIds = payload.ids ?? Array.from(session.candidates.keys())
      // 回收站条目（已在回收站内）按 id 反查真实路径，文件系统彻底删除，不参与普通文件删除流程
      const recycleIds = allIds.filter(
        (id) => session.candidates.get(id)?.rule_id === 'recycle',
      )
      const fileIds = allIds.filter(
        (id) => session.candidates.get(id)?.rule_id !== 'recycle',
      )

      // 系统级清理项（Windows.old / 更新缓存 / 内存转储等）位于受保护前缀下，
      // 仅在本次显式勾选且候选确属该项声明目录时才放行，避免「一次勾选全盘放行」。
      const allowSystemPrefixes = collectAllowSystemPrefixes(
        session.candidates,
        payload.ids,
      )

      const result =
        fileIds.length || payload.ids === null
          ? await deleteCandidates(session.candidates, payload.ids === null ? null : fileIds, payload.purge, {
              allowSystemPrefixes,
              // 每成功删除一项即推送进度：前端实时移除列表项并累计「已删除 N 条」
              onDeleted: (c) => {
                win.webContents.send('clean:progress', {
                  type: 'items',
                  ids: [c.id],
                })
              },
            })
          : emptyResult()

      if (recycleIds.length) {
        const order: Array<{ id: string; size: number; category: string; path: string }> = []
        const delEntries: Array<{ rPath: string; iPath: string }> = []
        for (const id of recycleIds) {
          const c = session.candidates.get(id)
          const entry = appState.recycleSession?.items.get(id)
          if (c && entry) {
            order.push({ id, size: c.size, category: c.category, path: c.path })
            delEntries.push({ rPath: entry.rPath, iPath: entry.iPath })
          }
        }
        if (delEntries.length) {
          // rPath → id 反查表：分批回调里按 rPath 找回候选 id 推送进度
          const idByRPath = new Map<string, string>()
          order.forEach((o, idx) => idByRPath.set(delEntries[idx].rPath, o.id))
          const res = await deleteRecycleEntries(delEntries, (batchRes) => {
            const ids = batchRes
              .filter((r) => r.ok)
              .map((r) => idByRPath.get(r.rPath))
              .filter((x): x is string => !!x)
            if (ids.length) {
              win.webContents.send('clean:progress', { type: 'items', ids })
            }
          })
          const logged: CleanCandidate[] = []
          order.forEach((o, idx) => {
            const r = res[idx]
            if (r && r.ok) {
              result.deleted_count += 1
              result.deleted_size += o.size
              logged.push({
                id: o.id,
                path: o.path,
                size: o.size,
                category: o.category,
                rule_id: 'recycle',
              })
            } else {
              result.errors.push(`${o.path} 删除失败：${r?.error || '未知错误'}`)
            }
          })
          if (logged.length) logDeletion(logged, true)
        }
      }
      return result
    },
  )

  // 重复文件：开始流式扫描（三级筛选，逐组推送 + 哈希进度）
  ipcMain.on('scan-duplicates:start', async (_e, payload: { minMb: number; drive?: string }) => {
    appState.resetCancel()
    const groups: import('../engine/model').DuplicateGroup[] = []
    try {
      for await (const ev of scanDuplicatesStream(
        { minMb: payload.minMb, drive: payload?.drive ?? '' },
        () => appState.cancel,
      )) {
        if (ev.type === 'progress') {
          win.webContents.send('scan-duplicates', { type: 'progress', n: ev.n })
        } else {
          win.webContents.send('scan-duplicates', { type: 'group', group: ev.group })
          groups.push(ev.group)
        }
      }
    } catch (err) {
      win.webContents.send('scan-duplicates', {
        type: 'error',
        message: String(err instanceof Error ? err.message : err),
      })
      return
    }

    // 把每个重复文件登记为候选，存入隔离的 dup 会话（id 反查 + 受保护校验）
    const cands: import('../engine/model').CleanCandidate[] = []
    for (const g of groups) {
      for (const f of g.files) {
        cands.push({
          id: f.id,
          path: f.path,
          size: f.size,
          category: 'duplicate',
          rule_id: g.group_id,
        })
      }
    }
    appState.setDupSession(cands)

    // 完成：按可释放空间降序发权威结果
    const sorted = groups.slice().sort((a, b) => b.wasted - a.wasted)
    win.webContents.send('scan-duplicates', { type: 'done', result: sorted })
  })

  // 删除指定重复文件（安全删除：受保护路径拦截 + 默认回收站 + 审计）
  ipcMain.handle(
    'delete-duplicates',
    async (
      _e,
      payload: { ids: string[]; purge: boolean },
    ): Promise<CleanResult> => {
      const session = appState.dupSession
      if (!session) {
        return {
          deleted_count: 0,
          deleted_size: 0,
          skipped: [],
          errors: ['没有可删除的重复文件，请先执行重复扫描'],
        }
      }
      return deleteCandidates(session.candidates, payload.ids, payload.purge)
    },
  )

  // 启动项：流式扫描（注册表 + 启动文件夹 + 任务计划）
  ipcMain.on('scan-startup:start', async () => {
    appState.resetCancel()
    const all: import('../engine/model').StartupEntry[] = []
    try {
      for await (const batch of scanStartupStream(() => appState.cancel)) {
        win.webContents.send('scan-startup', { type: 'item', items: batch })
        all.push(...batch)
      }
    } catch (err) {
      win.webContents.send('scan-startup', {
        type: 'error',
        message: String(err instanceof Error ? err.message : err),
      })
      return
    }
    win.webContents.send('scan-startup', { type: 'done', result: all })
  })

  // 启用 / 禁用启动项（失败原因回传，HKLM 项需管理员权限）
  ipcMain.handle(
    'set-startup-enabled',
    async (
      _e,
      payload: { id: string; enabled: boolean },
    ): Promise<{ ok: boolean; error: string | null }> => {
      try {
        await setStartupEnabled(payload.id, payload.enabled)
        return { ok: true, error: null }
      } catch (e) {
        return {
          ok: false,
          error: String(e instanceof Error ? e.message : e),
        }
      }
    },
  )

  // 已安装程序：流式扫描（与「程序和功能」同源）
  ipcMain.on('scan-uninstall:start', async () => {
    appState.resetCancel()
    const all: import('../engine/model').UninstallEntry[] = []
    try {
      for await (const batch of scanUninstallStream(() => appState.cancel)) {
        win.webContents.send('scan-uninstall', { type: 'item', items: batch })
        all.push(...batch)
      }
    } catch (err) {
      win.webContents.send('scan-uninstall', {
        type: 'error',
        message: String(err instanceof Error ? err.message : err),
      })
      return
    }
    win.webContents.send('scan-uninstall', { type: 'done', result: all })
  })

  // 触发原生卸载：命令由后端从注册表反查，前端仅传 id；无论成败都记审计
  ipcMain.handle(
    'uninstall',
    async (
      _e,
      payload: { id: string; quiet: boolean },
    ): Promise<import('../engine/model').UninstallResult> => {
      const res = await uninstallProgram(payload.id, payload.quiet)
      if (res.launched) logUninstall(payload.id, res.command)
      return res
    },
  )

  // 增强清理项目录（14 项，含风险等级与说明文案，供前端渲染勾选项）
  ipcMain.handle('list-extra-junk', async () => extraJunkItems())

  // ---- 注册表清理 ----

  // 流式扫描无效注册表项
  ipcMain.on('scan-registry:start', async () => {
    appState.resetCancel()
    const all: import('../engine/model').RegistryEntry[] = []
    try {
      for await (const batch of scanRegistryStream(() => appState.cancel)) {
        win.webContents.send('scan-registry', { type: 'item', items: batch })
        all.push(...batch)
      }
    } catch (err) {
      win.webContents.send('scan-registry', {
        type: 'error',
        message: String(err instanceof Error ? err.message : err),
      })
      return
    }
    appState.setRegSession(all)
    win.webContents.send('scan-registry', { type: 'done', result: all })
  })

  // 删除选中的注册表项（先备份；id 从会话反查，前端无法注入键路径）
  ipcMain.handle(
    'delete-registry',
    async (
      _e,
      ids: string[],
    ): Promise<import('../engine/model').RegistryCleanResult> => {
      const session = appState.regSession
      if (!session) {
        return {
          deleted_count: 0,
          skipped: [],
          errors: ['没有可清理的扫描结果，请先执行扫描'],
          backup_file: null,
        }
      }
      const entries = ids
        .map((id) => session.entries.get(id))
        .filter((e): e is import('../engine/model').RegistryEntry => !!e)
      return deleteRegistryEntries(entries)
    },
  )

  // 备份列表 / 恢复
  ipcMain.handle('list-registry-backups', () => listBackups())
  ipcMain.handle(
    'restore-registry',
    async (
      _e,
      file: string,
    ): Promise<{ restored: number; errors: string[] }> =>
      restoreBackup(file),
  )

  // ---- 清理规则 ----

  // 列出规则（内置 + 用户 JSON 规则）
  ipcMain.handle(
    'list-rules',
    async (): Promise<import('../engine/model').RuleInfo[]> => {
      const out: import('../engine/model').RuleInfo[] = []
      for (const r of builtinJunkRules()) {
        out.push({
          id: r.id,
          name: r.name,
          description: r.description,
          category: r.category,
          enabled: true,
          source: 'builtin',
          paths: r.dirs,
          max_age_days: r.max_age_days,
        })
      }
      for (const r of loadUserRules()) {
        out.push({
          id: r.id,
          name: r.name,
          description: r.description,
          category: r.category,
          enabled: r.enabled,
          source: 'user',
          paths: r.paths,
          max_age_days: r.max_age_days,
        })
      }
      return out
    },
  )

  // 新增 / 覆盖一条用户规则
  ipcMain.handle(
    'add-user-rule',
    async (
      _e,
      rule: import('../engine/model').UserRuleInput,
    ): Promise<{ ok: boolean; error: string | null }> => {
      try {
        const full: UserRule = {
          id: rule.id.trim(),
          name: rule.name?.trim() || rule.id.trim(),
          category: rule.category?.trim() || '自定义',
          description: rule.description ?? '',
          enabled: rule.enabled !== false,
          paths: rule.paths,
          max_age_days: Number(rule.max_age_days) || 0,
          min_size_kb: Number(rule.min_size_kb) || 0,
        }
        saveUserRule(full)
        return { ok: true, error: null }
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) }
      }
    },
  )

  // 删除一条用户规则
  ipcMain.handle(
    'delete-user-rule',
    async (_e, id: string): Promise<{ ok: boolean; error: string | null }> => {
      try {
        deleteUserRuleFile(id)
        return { ok: true, error: null }
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) }
      }
    },
  )

  // 规则目录路径（展示用）
  ipcMain.handle('get-rules-dir', () => rulesDir())

  // 在资源管理器中打开规则目录
  ipcMain.handle('open-rules-dir', async () => {
    await shell.openPath(rulesDir())
  })

  // 在资源管理器中打开「某个文件 / 目录」所在的目录。
  // 目录直接打开；文件则定位到其所在文件夹（showItemInFolder 在部分环境异常，
  // 这里统一用 openPath 打开父目录，行为稳定且无需管理员权限）。
  ipcMain.handle(
    'open-path',
    async (
      _e,
      payload: { path: string },
    ): Promise<{ ok: boolean; error: string | null }> => {
      const raw = String(payload?.path ?? '')
      if (!raw) return { ok: false, error: 'empty path' }
      try {
        // 统一规范化：fast-glob 等来源可能给出正斜杠路径，ShellExecute 对
        // "D:/a/b" 这类路径有时解析失败（表现就是 Explorer 弹「找不到文件」）；
        // path.resolve 会转成 Windows 标准反斜杠形式。
        const target = resolvePath(raw)
        // 目录直接打开；文件则打开其所在目录（不是打开文件本身）
        const dir = existsSync(target)
          ? statSync(target).isDirectory()
            ? target
            : dirname(target)
          : dirname(target)
        if (!existsSync(dir)) {
          return { ok: false, error: `目录不存在：${dir}` }
        }
        const openErr = await shell.openPath(dir)
        // openPath 成功返回空串，失败返回系统错误描述
        if (openErr) {
          // 回退：在资源管理器中定位（选中）该文件，同样达到「看到文件在哪」
          if (existsSync(target) && !statSync(target).isDirectory()) {
            shell.showItemInFolder(target)
            return { ok: true, error: null }
          }
          return { ok: false, error: openErr }
        }
        return { ok: true, error: null }
      } catch (e) {
        return {
          ok: false,
          error: String(e instanceof Error ? e.message : e),
        }
      }
    },
  )

  // ---------------- 扫描记录（JSON 文件存储 · 上次扫描时间 + 结果摘要）----------------
  ipcMain.handle(
    'history:get',
    async (_e, payload: { module: string }): Promise<import('../engine/history').ScanRecord | null> => {
      return getScanRecord(payload?.module ?? '')
    },
  )

  ipcMain.handle(
    'history:record',
    async (
      _e,
      payload: { module: string; summary: string },
    ): Promise<import('../engine/history').ScanRecord> => {
      return recordScan(payload?.module ?? '', payload?.summary ?? '')
    },
  )

  // ---------------- 多语言（JSON 语言包 · 热增减）----------------
  // 每次调用都重新读盘：运行中往目录增删 JSON 文件，设置页刷新即可生效。
  ipcMain.handle('i18n:list', async (): Promise<LocaleMeta[]> => {
    return listLocales()
  })

  ipcMain.handle(
    'i18n:get',
    async (_e, payload: { code: string }): Promise<Record<string, string>> => {
      return getMessages(payload?.code ?? '')
    },
  )

  ipcMain.handle('i18n:dir', async (): Promise<string> => {
    return i18nDir()
  })

  ipcMain.handle('i18n:open-dir', async () => {
    await shell.openPath(i18nDir())
  })

  // ---- 定时清理 ----

  ipcMain.handle(
    'list-schedules',
    async (): Promise<import('../engine/model').ScheduleConfig[]> =>
      listSchedules(),
  )

  // 新增计划（注册 Windows 任务 + 落盘配置，失败自动回滚任务）
  ipcMain.handle(
    'add-schedule',
    async (
      _e,
      cfg: import('../engine/model').ScheduleConfig,
    ): Promise<{ ok: boolean; error: string | null }> => {
      try {
        await addSchedule(cfg)
        return { ok: true, error: null }
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) }
      }
    },
  )

  // 删除计划（配置 + Windows 任务）
  ipcMain.handle(
    'delete-schedule',
    async (_e, id: string): Promise<{ ok: boolean; error: string | null }> => {
      try {
        await removeSchedule(id)
        return { ok: true, error: null }
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) }
      }
    },
  )

  // 可勾选的清理范围
  ipcMain.handle(
    'list-privacy-rules',
    async (): Promise<import('../engine/model').PrivacyRuleOption[]> =>
      privacyRuleOptions(),
  )

  // 立即执行一次隐私清理（复用七道防线，仅移入回收站）
  ipcMain.handle(
    'run-privacy-now',
    async (_e, ruleIds: string[] | null): Promise<CleanResult> =>
      runPrivacyCleanup(ruleIds ?? []),
  )

  // 窗口控制（无边框；主窗体不支持最大化，故不提供 toggle-maximize）
  ipcMain.on('window:minimize', () => win.minimize())
  ipcMain.on('window:close', () => win.close())

  // 窗口置顶切换：返回切换后的状态（前端据此更新图标高亮）
  ipcMain.handle('window:toggle-always-on-top', (): boolean => {
    const next = !win.isAlwaysOnTop()
    win.setAlwaysOnTop(next, 'floating')
    return win.isAlwaysOnTop()
  })

  // 读取当前置顶状态（窗口重新显示 / 恢复后前端状态可能与实际不一致，用它校准）
  ipcMain.handle('window:is-always-on-top', (): boolean => win.isAlwaysOnTop())

  // 应用版本
  ipcMain.handle('app:version', () => app.getVersion())

  // 系统属性信息（概览页展示：操作系统 / 架构 / 处理器 / 内存 / 计算机名 / 用户）
  // force=true 表示忽略磁盘/内存缓存重新采集（概览页「刷新」按钮）
  ipcMain.handle(
    'get-system-info',
    async (_e, force?: boolean): Promise<SystemInfo> => getSystemInfo(force === true),
  )

  // 一键体检：编排各扫描 + 评分，返回完整报告
  ipcMain.handle('health:scan', async (): Promise<HealthReport> => {
    appState.resetCancel()
    return runHealthScan(() => appState.cancel)
  })

  // 社交缓存：流式扫描（按应用分批产出，含四级风险条目）
  ipcMain.on('scan-social:start', async () => {
    appState.resetCancel()
    const all: SocialItem[] = []
    try {
      for await (const batch of scanSocialStream(() => appState.cancel)) {
        win.webContents.send('scan-social', { type: 'item', items: batch })
        all.push(...batch)
      }
    } catch (err) {
      win.webContents.send('scan-social', {
        type: 'error',
        message: String(err instanceof Error ? err.message : err),
      })
      return
    }
    appState.setSocialSession(all)
    win.webContents.send('scan-social', {
      type: 'done',
      result: all,
      levels: LEVEL_META,
      cancelled: appState.cancel,
    })
  })

  ipcMain.on('scan-social:cancel', () => {
    appState.cancel = true
  })

  // 社交缓存：清理（锁定项后端二次拒绝，默认进回收站）
  ipcMain.handle(
    'delete-social',
    async (_e, payload: { ids: string[]; purge?: boolean }): Promise<CleanResult> => {
      const session = appState.socialSession
      if (!session) return emptyResult()
      return deleteSocialItems(session.items, payload?.ids ?? [], !!payload?.purge)
    },
  )

  // 大文件 / 单文件：删除（默认移入回收站）。
  // 大文件分析是「只读分析」，单条删除不走清理会话，直接按路径操作，
  // 移入回收站而非永久删除，避免误删造成不可逆损失。
  ipcMain.handle(
    'delete-one',
    async (
      _e,
      payload: { path: string },
    ): Promise<{ ok: boolean; error: string | null }> => {
      const p = payload?.path ?? ''
      if (!p) return { ok: false, error: 'empty path' }
      // 文件已不存在（可能已手动删除）：视为成功，界面自行移除
      if (!existsSync(p)) return { ok: true, error: null }
      try {
        await moveToRecycleBin(p)
        logDeletion(
          [
            {
              id: p,
              path: p,
              size: 0,
              category: '大文件',
              rule_id: 'bigfile',
            },
          ],
          true,
        )
        return { ok: true, error: null }
      } catch (e) {
        return {
          ok: false,
          error: String(e instanceof Error ? e.message : e),
        }
      }
    },
  )

  // 磁盘信息：所有本地卷 + 物理磁盘清单 + 单盘 SMART 概览
  ipcMain.handle('disk:list', async (): Promise<DiskInfo[]> => {
    return getAllDiskInfo()
  })

  ipcMain.handle('disk:physical', async (): Promise<PhysicalDiskInfo[]> => {
    return getPhysicalDisks()
  })

  ipcMain.handle(
    'disk:smart',
    async (_e, payload: { deviceId: number }): Promise<SmartRow[]> => {
      return getSmartOverview(payload?.deviceId ?? -1)
    },
  )

  ipcMain.handle(
    'disk:info',
    async (_e, payload: { letter: string }): Promise<DiskInfo | null> => {
      return getDiskInfoByLetter(payload?.letter ?? '')
    },
  )

  // ---------------- 安装包清理（§3.7）----------------
  ipcMain.on(
    'scan-installers:start',
    async (_e, payload: { minSizeMb: number; minDays: number; drive?: string }) => {
      appState.resetCancel()
      const all: InstallerItem[] = []
      try {
        for await (const batch of scanInstallersStream(
          payload?.minSizeMb ?? 10,
          payload?.minDays ?? 30,
          () => appState.cancel,
          payload?.drive ?? '',
        )) {
          win.webContents.send('scan-installers', { type: 'item', items: batch })
          all.push(...batch)
        }
      } catch (err) {
        win.webContents.send('scan-installers', {
          type: 'error',
          message: String(err instanceof Error ? err.message : err),
        })
        return
      }
      appState.setItemSession('installerSession', all)
      win.webContents.send('scan-installers', {
        type: 'done',
        result: all,
        cancelled: appState.cancel,
      })
    },
  )

  ipcMain.on('scan-installers:cancel', () => {
    appState.cancel = true
  })

  ipcMain.handle(
    'delete-installers',
    async (_e, payload: { ids: string[]; purge?: boolean }): Promise<CleanResult> => {
      const s = appState.installerSession
      if (!s) return emptyResult()
      return deleteInstallers(s.items, payload?.ids ?? [], !!payload?.purge)
    },
  )

  // ---------------- 日志清理（§3.8）----------------
  ipcMain.on(
    'scan-logs:start',
    async (_e, payload: { minDays: number; drive?: string }) => {
      appState.resetCancel()
      const all: LogItem[] = []
      try {
        for await (const batch of scanLogsStream(
          payload?.minDays ?? 0,
          payload?.drive ?? '',
          () => appState.cancel,
        )) {
        win.webContents.send('scan-logs', { type: 'item', items: batch })
        all.push(...batch)
      }
    } catch (err) {
      win.webContents.send('scan-logs', {
        type: 'error',
        message: String(err instanceof Error ? err.message : err),
      })
      return
    }
    appState.setItemSession('logSession', all)
    win.webContents.send('scan-logs', {
      type: 'done',
      result: all,
      groups: LOG_GROUP_META,
      cancelled: appState.cancel,
    })
  })

  ipcMain.on('scan-logs:cancel', () => {
    appState.cancel = true
  })

  ipcMain.handle(
    'delete-logs',
    async (_e, payload: { ids: string[]; purge?: boolean }): Promise<CleanResult> => {
      const s = appState.logSession
      if (!s) return emptyResult()
      return deleteLogs(s.items, payload?.ids ?? [], !!payload?.purge)
    },
  )

  // ---------------- C 盘瘦身（§3.12）----------------
  ipcMain.handle('slim:plan', async (): Promise<SlimItem[]> => {
    return slimPlan()
  })

  ipcMain.handle(
    'slim:run',
    async (_e, payload: { kinds: SlimKind[] }): Promise<
      Array<{ kind: SlimKind; ok: boolean; message: string }>
    > => {
      return runSlim(payload?.kinds ?? [])
    },
  )

  // ---------------- 右键菜单清理（§3.13）----------------
  ipcMain.on('ctx:scan:start', async () => {
    appState.resetCancel()
    const all: ContextMenuItem[] = []
    try {
      for await (const batch of scanContextMenuStream(() => appState.cancel)) {
        win.webContents.send('ctx:scan', { type: 'item', items: batch })
        all.push(...batch)
      }
    } catch (e) {
      win.webContents.send('ctx:scan', {
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
      })
      return
    }
    appState.setItemSession('ctxSession', all)
    win.webContents.send('ctx:scan', { type: 'done', result: all })
  })

  ipcMain.handle(
    'ctx:set-disabled',
    async (
      _e,
      payload: { ids: string[]; disabled: boolean },
    ): Promise<Array<{ id: string; ok: boolean; message: string }>> => {
      const s = appState.ctxSession
      if (!s) return []
      return setContextMenuDisabled(s.items, payload?.ids ?? [], !!payload?.disabled)
    },
  )

  ipcMain.handle(
    'ctx:delete',
    async (
      _e,
      payload: { ids: string[] },
    ): Promise<Array<{ id: string; ok: boolean; message: string }>> => {
      const s = appState.ctxSession
      if (!s) return []
      return deleteContextMenu(s.items, payload?.ids ?? [])
    },
  )

  ipcMain.handle('ctx:backup-dir', async (): Promise<string> => {
    return ctxBackupDir()
  })

  // ---------------- 驱动清理（§3.14）----------------
  ipcMain.on('drivers:scan:start', async () => {
    console.log('[main] drivers:scan:start received')
    console.log('[main] win ready=' + (typeof win !== 'undefined' && !!win && !win.isDestroyed()))
    const t0 = Date.now()
    appState.resetCancel()
    const all: DriverItem[] = []
    try {
      for await (const batch of scanDriversStream(
      () => appState.cancel,
      (s, t) =>
        win.webContents.send('drivers:scan', {
          type: 'progress',
          scanned: s,
          total: t,
        }),
    )) {
      win.webContents.send('drivers:scan', { type: 'item', items: batch })
      all.push(...batch)
      console.log('[main] drivers batch size=' + batch.length + ' cumulative=' + all.length)
    }
    } catch (e) {
      console.log('[main] drivers:scan ERROR: ' + (e instanceof Error ? e.message : String(e)))
      win.webContents.send('drivers:scan', {
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
      })
      return
    }
    appState.setItemSession('driverSession', all)
    // 完成：按体积降序发权威结果（前端用其覆盖累加列表）
    all.sort((a, b) => b.size - a.size)
    console.log('[main] drivers:scan done total=' + all.length + ' in ' + (Date.now() - t0) + 'ms')
    win.webContents.send('drivers:scan', {
      type: 'done',
      result: all,
      note: getLastDriverDiag(),
    })
  })

  ipcMain.handle(
    'drivers:delete',
    async (
      _e,
      payload: { ids: string[] },
    ): Promise<Array<{ id: string; ok: boolean; message: string }>> => {
      const s = appState.driverSession
      if (!s) return []
      return deleteDrivers(s.items, payload?.ids ?? [])
    },
  )

  // ---------------- 卸载残留（§3.11）----------------
  ipcMain.on(
    'scan-residue:start',
    async (_e, payload: { minSizeMb?: number; minDays?: number }) => {
      appState.resetCancel()
      const all: ResidueItem[] = []
      try {
        for await (const batch of scanResidueStream(
          payload?.minSizeMb ?? 10,
          payload?.minDays ?? 60,
          () => appState.cancel,
        )) {
          if (appState.cancel) break
          all.push(...batch)
          win.webContents.send('scan-residue', { type: 'item', items: batch })
        }
        appState.setItemSession('residueSession', all)
        win.webContents.send('scan-residue', { type: 'done', result: all })
      } catch (e) {
        win.webContents.send('scan-residue', {
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      }
    },
  )

  ipcMain.on('scan-residue:cancel', () => {
    appState.cancel = true
  })

  ipcMain.handle(
    'delete-residue',
    async (_e, payload: { ids: string[]; purge: boolean }): Promise<CleanResult> => {
      const s = appState.residueSession
      if (!s) return emptyResult()
      return deleteResidue(s.items, payload?.ids ?? [], !!payload?.purge)
    },
  )

  // ---------------- 软件数据迁移（§5.2）----------------
  ipcMain.on('migrate:list:start', async (_e, payload: { minMb?: number }) => {
    appState.resetCancel()
    const all: MigrateItem[] = []
    try {
      for await (const batch of listMigratableStream(
        payload?.minMb ?? 200,
        () => appState.cancel,
      )) {
        win.webContents.send('migrate:list', { type: 'item', items: batch })
        all.push(...batch)
      }
    } catch (e) {
      win.webContents.send('migrate:list', {
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
      })
      return
    }
    // 完成：迁移/还原按 id 反查 appState.migrateItems，故在 done 时写入完整清单
    all.sort((a, b) => b.size - a.size)
    appState.migrateItems = all
    win.webContents.send('migrate:list', { type: 'done', result: all })
  })

  ipcMain.handle(
    'migrate:targets',
    async (): Promise<Array<{ letter: string; freeBytes: number; totalBytes: number }>> => {
      return listTargetRoots()
    },
  )

  ipcMain.handle(
    'migrate:run',
    async (
      _e,
      payload: { id: string; targetRoot: string },
    ): Promise<{ id: string; ok: boolean; message: string }> => {
      return migrateDirectory(appState.migrateItems, payload?.id ?? '', payload?.targetRoot ?? '')
    },
  )

  ipcMain.handle(
    'migrate:restore',
    async (_e, payload: { id: string }): Promise<{ id: string; ok: boolean; message: string }> => {
      return restoreDirectory(appState.migrateItems, payload?.id ?? '')
    },
  )

  // ---------------- 外壳图标清理（§3.13）----------------
  ipcMain.on('icons:scan:start', async () => {
    appState.resetCancel()
    const all: ShellIconItem[] = []
    try {
      for await (const batch of scanShellIconsStream(() => appState.cancel)) {
        win.webContents.send('icons:scan', { type: 'item', items: batch })
        all.push(...batch)
      }
    } catch (e) {
      win.webContents.send('icons:scan', {
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
      })
      return
    }
    appState.setItemSession('iconSession', all)
    win.webContents.send('icons:scan', { type: 'done', result: all })
  })

  ipcMain.handle(
    'icons:delete',
    async (
      _e,
      payload: { ids: string[] },
    ): Promise<Array<{ id: string; ok: boolean; message: string }>> => {
      const s = appState.iconSession
      if (!s) return []
      return deleteShellIcons(s.items, payload?.ids ?? [])
    },
  )

  // ---------------- 磁盘优化（§5.1）----------------
  ipcMain.handle(
    'opt:status',
    async (_e, payload: { letter: string }): Promise<OptimizeOption[]> => {
      return getOptimizeStatus(payload?.letter ?? 'C')
    },
  )

  ipcMain.handle(
    'opt:trim',
    async (_e, payload: { enable: boolean }): Promise<OptimizeResult> => {
      return setTrimEnabled(!!payload?.enable)
    },
  )

  ipcMain.handle(
    'opt:defrag',
    async (_e, payload: { letter: string; analyze: boolean }): Promise<OptimizeResult> => {
      return runDefrag(payload?.letter ?? 'C', !!payload?.analyze)
    },
  )

  // 打开系统「存储感知」设置页（引导，不改注册表）
  ipcMain.handle('opt:storagesense-open', async (): Promise<OptimizeResult> => {
    await shell.openExternal('ms-settings:storagesense')
    return { ok: true, message: '已打开系统存储感知设置页' }
  })

  ipcMain.handle('opt:storagesense-run', async (): Promise<OptimizeResult> => {
    return runStorageSenseNow()
  })

  ipcMain.handle(
    'opt:compactos',
    async (_e, payload: { enable: boolean }): Promise<OptimizeResult> => {
      return setCompactOs(!!payload?.enable)
    },
  )

  // ---------------- 启动加速（§5.3）----------------
  ipcMain.handle('opt:services', async (): Promise<DelayableService[]> => {
    return listDelayableServices()
  })

  ipcMain.handle(
    'opt:service-delayed',
    async (_e, payload: { name: string; delayed: boolean }): Promise<OptimizeResult> => {
      return setServiceDelayed(payload?.name ?? '', !!payload?.delayed)
    },
  )

  // ---------------- WSL / Docker 检测（§5.3）----------------
  ipcMain.handle('opt:vhd', async (): Promise<VhdInfo[]> => {
    return detectVhd()
  })

  // ---------------- 虚拟内存（§5.3）----------------
  ipcMain.handle('pf:info', async (): Promise<PagefileInfo> => {
    return getPagefileInfo()
  })

  ipcMain.handle('pf:targets', async (): Promise<PagefileTarget[]> => {
    return listPagefileTargets()
  })

  ipcMain.handle(
    'pf:apply',
    async (
      _e,
      payload: { mode: 'auto' | 'custom' | 'move'; letter: string; initialMb: number; maxMb: number },
    ): Promise<PagefileApplyResult> => {
      return applyPagefile(
        payload?.mode ?? 'auto',
        payload?.letter ?? '',
        payload?.initialMb ?? 0,
        payload?.maxMb ?? 0,
      )
    },
  )

  // ---------------- 系统还原点（§3.9 / §5.3）----------------
  ipcMain.handle('rp:status', async (): Promise<RestoreStatus> => {
    return getRestoreStatus()
  })

  ipcMain.handle(
    'rp:delete-old',
    async (_e, payload: { keep: number }): Promise<RestoreResult> => {
      return deleteOldRestorePoints(payload?.keep ?? 1)
    },
  )

  ipcMain.handle(
    'rp:set-max',
    async (_e, payload: { pct: number }): Promise<RestoreResult> => {
      return setRestoreMaxPercent(payload?.pct ?? 5)
    },
  )

  ipcMain.handle(
    'rp:set-protection',
    async (_e, payload: { enable: boolean }): Promise<RestoreResult> => {
      return setSystemProtection(!!payload?.enable)
    },
  )

  // ---------------- 大目录钻取（§5.3）----------------
  ipcMain.handle('tm:roots', async (): Promise<Array<{ label: string; path: string }>> => {
    return defaultRoots()
  })

  ipcMain.handle(
    'tm:analyze',
    async (_e, payload: { root: string; depth: number }): Promise<TreeNode> => {
      appState.resetCancel()
      return analyzeDirectory(payload?.root ?? '', payload?.depth ?? 2, () => appState.cancel, (p) => {
        win.webContents.send('tm:progress', p as AnalyzeProgress)
      })
    },
  )

  ipcMain.on('tm:cancel', () => {
    appState.cancel = true
  })

  // ---------------- 磁盘空间变化分析（§5.3）----------------
  ipcMain.handle(
    'snap:take',
    async (_e, payload: { root?: string }): Promise<Snapshot> => {
      appState.resetCancel()
      return takeSnapshot(payload?.root, () => appState.cancel)
    },
  )

  ipcMain.on('snap:cancel', () => {
    appState.cancel = true
  })

  ipcMain.handle('snap:list', async (): Promise<Snapshot[]> => {
    return listSnapshots()
  })

  ipcMain.handle('snap:delete', async (_e, payload: { id: string }): Promise<boolean> => {
    return deleteSnapshot(payload?.id ?? '')
  })

  ipcMain.handle(
    'snap:diff',
    async (_e, payload: { baseId: string; targetId: string }): Promise<SnapshotDiff | null> => {
      return diffSnapshots(payload?.baseId ?? '', payload?.targetId ?? '')
    },
  )

  // ---------------- 远程：更新检查 / 社区信息 / 反馈（均带本地示例回退）----------------
  ipcMain.handle(
    'check-update',
    async (_e): Promise<import('../engine/remote').UpdateInfo> => {
      return getUpdateInfo(app.getVersion())
    },
  )

  ipcMain.handle(
    'fetch-community',
    async (_e): Promise<import('../engine/remote').Community> => {
      return getCommunity()
    },
  )

  // 收款码：主进程下载远程图片并校验 SHA-256，校验不过不返回图片（只回错误码）
  ipcMain.handle(
    'fetch-donate-qr',
    async (_e, platform: string): Promise<DonateQrResult> => {
      return fetchDonateQr(String(platform ?? ''))
    },
  )

  ipcMain.handle(
    'submit-feedback',
    async (
      _e,
      payload: { name?: string; type?: string; contact?: string; content: string },
    ): Promise<import('../engine/remote').FeedbackResult> => {
      return submitFeedback({
        name: payload?.name,
        type: payload?.type,
        contact: payload?.contact,
        content: payload?.content ?? '',
      })
    },
  )

  // 程序完整性校验：本机 app.asar / exe 的 SHA-256 与官方发布值比对（需联网）
  ipcMain.handle(
    'verify-integrity',
    async (_e): Promise<import('../engine/remote').IntegrityResult> => {
      return verifyIntegrity({
        version: app.getVersion(),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath ?? '',
        exePath: app.getPath('exe'),
      })
    },
  )

  // 用系统默认浏览器 / 邮件客户端打开外链。
  // 白名单：http(s) 与 mailto（mailto 只是唤起邮件客户端，不可下载执行内容）；
  // 其余协议（file://、smb://、自定义 scheme…）一律拒绝，避免被诱导打开本地文件或执行程序。
  ipcMain.handle('open-external', async (_e, url: string): Promise<boolean> => {
    const u = String(url ?? '').trim()
    const httpOk = /^https?:\/\/\S+$/i.test(u)
    // mailto: 后必须是合法的单个邮箱地址，不接受附加参数以免被塞入其它内容
    const mailOk = /^mailto:[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/i.test(u)
    if (!httpOk && !mailOk) return false
    await shell.openExternal(u)
    return true
  })
}
