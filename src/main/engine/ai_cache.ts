/**
 * AI 软件缓存专清（设计稿「社交软件专清」同款体验的姊妹模块）。
 *
 * 这些 AI 原生 IDE / 编程智能体 / 本地模型运行器 / 桌面 AI 助手，会在
 * %APPDATA% / %LOCALAPPDATA% / %USERPROFILE% 下堆积大量缓存：扩展缓存、日志、
 * 临时文件、更新包、代码索引、本地大模型权重等，动辄数 GB 且不会自动回收。
 *
 * 清理策略（与社交专清同构，但只分两级，因为 AI 软件没有「聊天记录库」这种
 * 必须永久锁死的概念）：
 *   ① 安全 · 缓存/日志/更新（Cache / Temp / Log / 更新缓存）—— 可重建，默认勾选
 *   ② 谨慎 · 模型/索引/工作区（本地模型权重 / 代码索引 / 工作区状态）—— 默认不勾
 *
 * 删除防线（与社交专清一致，从机制上杜绝误删）：
 * 1. 仅接受本次会话内的 `id`，从会话反查真实路径，前端无法注入任意路径；
 * 2. 默认移入回收站，purge=true 才永久删除；
 * 3. 每个文件执行期再校验 `isProtected`；
 * 4. 成功删除写入审计日志；
 * 5. 主动排除本工具自身（GrClean），绝不误清；WorkBuddy 作为普通 AI 软件纳入清理。
 *
 * 路径说明：各 AI 软件目录命名随版本变动，扫描常见候选目录 best-effort，
 * 未命中的软件不产出条目；前端仍会把该软件列为空分组以体现「已检测、无缓存」。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { expandEnv } from './rules'
import { isProtected } from './protected'
import { logDeletion } from './audit'
import { moveManyToRecycleBin } from './trash-bin'
import type { CleanCandidate, CleanResult } from './model'
import type { LevelMeta } from './social'

/** 两级风险。 */
export type AiLevel = 'safe' | 'caution'

/** 每一级的展示元信息（对齐社交专清的分级总览配色与默认行为）。 */
export const AI_LEVEL_META: Record<AiLevel, LevelMeta> = {
  safe: {
    order: 1,
    label: '① 安全 · 缓存/日志/更新',
    desc: '可自动重建，放心删（Cache / Temp / Log / 更新缓存）',
    color: '#3a9d3a',
    recommend: true,
    locked: false,
  },
  caution: {
    order: 2,
    label: '② 谨慎 · 模型/索引/工作区',
    desc: '可能还想保留（本地模型权重 / 代码索引 / 工作区），默认不勾',
    color: '#d98324',
    recommend: false,
    locked: false,
  },
}

interface AiApp {
  name: string
  /** 候选根目录（展开 %ENV% 后，不存在则跳过）；命中即递归下钻。 */
  dirs: string[]
}

/**
 * 受支持的 AI 软件（固定顺序，与 AiClean.vue 的 AI_APPS 保持一致）。
 * 分三类：AI 原生 IDE、本地模型运行/桌面 AI、CLI 编程智能体与编辑器内 AI 插件。
 * 路径为「常见安装位置」best-effort，未命中静默跳过。
 */
const AI_APPS: AiApp[] = [
  // —— AI 原生 IDE ——
  {
    name: 'Cursor',
    dirs: [
      '%USERPROFILE%\\.cursor',
      '%APPDATA%\\Cursor',
      '%LOCALAPPDATA%\\Cursor',
      '%LOCALAPPDATA%\\cursor-updater',
    ],
  },
  {
    name: 'Windsurf',
    dirs: [
      '%USERPROFILE%\\.windsurf',
      '%APPDATA%\\Windsurf',
      '%LOCALAPPDATA%\\Windsurf',
      '%LOCALAPPDATA%\\windsurf-updater',
    ],
  },
  {
    name: 'Trae',
    dirs: [
      '%USERPROFILE%\\.trae',
      '%APPDATA%\\Trae',
      '%LOCALAPPDATA%\\Trae',
      '%LOCALAPPDATA%\\trae-updater',
    ],
  },
  // —— 本地模型运行 / 桌面 AI ——
  { name: 'Ollama', dirs: ['%USERPROFILE%\\.ollama', '%LOCALAPPDATA%\\Ollama'] },
  { name: 'LM Studio', dirs: ['%USERPROFILE%\\.lmstudio', '%APPDATA%\\LM Studio'] },
  { name: 'Jan', dirs: ['%APPDATA%\\Jan', '%LOCALAPPDATA%\\Jan'] },
  { name: 'GPT4All', dirs: ['%USERPROFILE%\\GPT4All'] },
  // —— 桌面聊天 / 助手 ——
  { name: 'ChatGPT', dirs: ['%APPDATA%\\ChatGPT', '%LOCALAPPDATA%\\ChatGPT'] },
  { name: 'DeepSeek', dirs: ['%APPDATA%\\DeepSeek', '%LOCALAPPDATA%\\DeepSeek'] },
  { name: '豆包', dirs: ['%APPDATA%\\Doubao', '%LOCALAPPDATA%\\Doubao'] },
  {
    // 桌面 AI 助手：Electron 缓存集中在 Roaming/Local，用户目录下的 cache/logs 为独立缓存根
    name: 'WorkBuddy',
    dirs: [
      '%APPDATA%\\WorkBuddy',
      '%LOCALAPPDATA%\\WorkBuddy',
      '%USERPROFILE%\\.workbuddy\\cache',
      '%USERPROFILE%\\.workbuddy\\logs',
    ],
  },
  // —— CLI 编程智能体 ——
  { name: 'Claude Code', dirs: ['%USERPROFILE%\\.claude', '%APPDATA%\\claude'] },
  { name: 'Codex CLI', dirs: ['%USERPROFILE%\\.codex', '%APPDATA%\\codex'] },
  { name: 'Gemini CLI', dirs: ['%USERPROFILE%\\.gemini', '%APPDATA%\\gemini'] },
  { name: 'Aider', dirs: ['%USERPROFILE%\\.aider'] },
  // —— 编辑器内 AI 插件（best-effort，未命中静默跳过）——
  {
    name: 'CodeBuddy',
    dirs: [
      '%APPDATA%\\Tencent\\CodeBuddy',
      '%USERPROFILE%\\.codebuddy',
      '%LOCALAPPDATA%\\CodeBuddy',
    ],
  },
  {
    name: '通义灵码',
    dirs: [
      '%APPDATA%\\Lingma',
      '%USERPROFILE%\\.lingma',
      '%APPDATA%\\Code\\User\\globalStorage\\aliyun.lingma',
    ],
  },
  {
    name: '文心快码Comate',
    dirs: [
      '%APPDATA%\\Baidu\\Comate',
      '%USERPROFILE%\\.comate',
      '%LOCALAPPDATA%\\Comate',
    ],
  },
  {
    name: 'CodeGeeX',
    dirs: [
      '%APPDATA%\\Code\\User\\globalStorage\\codegeex.codegeex',
      '%USERPROFILE%\\.codegeex',
    ],
  },
  {
    name: 'Codeium',
    dirs: [
      '%LOCALAPPDATA%\\Codeium',
      '%APPDATA%\\Code\\User\\globalStorage\\codeium.codeium',
    ],
  },
  { name: 'Tabnine', dirs: ['%APPDATA%\\Tabnine', '%LOCALAPPDATA%\\Tabnine'] },
  {
    name: 'Cody',
    dirs: [
      '%APPDATA%\\Code\\User\\globalStorage\\sourcegraph.cody',
      '%LOCALAPPDATA%\\Cody',
    ],
  },
  { name: 'Continue', dirs: ['%USERPROFILE%\\.continue', '%APPDATA%\\Continue'] },
]

/** 主动排除本工具自身：绝不误清 GrClean（即使被装到了上述 AI 软件目录下）。
 *  WorkBuddy 不再是排除项——它已作为普通 AI 软件纳入 AI_APPS 清理目标。 */
const SELF_NAMES = new Set(['grc', 'grcache', 'grcache.app', 'grcache.exe'])

/** 系统盘盘符（如 'C'）。 */
function systemDrive(): string {
  const sd = (process.env.SystemDrive || 'C:').replace(/:$/, '')
  return sd.toUpperCase()
}

let _drivesCache: string[] | null = null

/** 用 Node 原生方式探测可用盘符（C..Z，跳过 A/B 软驱 + 不可访问的盘）。 */
function probeDrives(): string[] {
  const out: string[] = []
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code)
    const root = `${letter}:\\`
    try {
      if (!fs.existsSync(root)) continue
      fs.statfsSync(root)
      out.push(letter)
    } catch {
      /* 不可访问（空光驱 / 无介质 / 网络不可达），跳过 */
    }
  }
  return out.length ? out : [systemDrive()]
}

/** 列出本机可用盘符，结果模块级缓存。 */
async function getFixedDrives(): Promise<string[]> {
  if (_drivesCache) return _drivesCache
  _drivesCache = probeDrives()
  return _drivesCache
}

/** ① 安全：缓存/日志/更新/临时类目录名（小写比对）。 */
const SAFE_DIRS = new Set([
  'cache',
  'caches',
  'cachedata',
  'cachedData',
  'CachedData',
  'gpuCache',
  'gpu-cache',
  'code cache',
  'codecache',
  'codeCache',
  'Code Cache',
  'blob_storage',
  'logs',
  'log',
  'tmp',
  'temp',
  'crashpad',
  'crashpad-reports',
  'Crashpad',
  'Crash Reports',
  'telemetry',
  'extension-cache',
  'extensioncache',
  'extensions-cache',
  'Extension Cache',
  'updater',
  'update',
  'Update',
  'installer',
  'Installer',
  'Download',
  'downloads',
  'session storage',
  'Session Storage',
])

/** ② 谨慎：模型权重/代码索引/工作区/用户数据类目录名（默认不勾）。
 * 本地模型权重（Ollama/LM Studio/Jan 的 models 目录）删除即丢失已下载模型；
 * Claude Code 的 projects 是索引过的代码库，删了需重新索引；其余为工作区/用户状态。 */
const CAUTION_DIRS = new Set([
  'models',
  'model',
  'projects',
  'project',
  'workspaceStorage',
  'workspace_storage',
  'globalStorage',
  'global_storage',
  'user',
  'history',
  'extensions',
  'extension',
  'indexes',
  'index',
  'repos',
  'repo',
  'indexeddb',
  'local storage',
  'localstorage',
  'localStorage',
])

export interface AiCacheItem {
  id: string
  /** 应用名，如「Cursor」 */
  app: string
  level: AiLevel
  /** 条目名（目录名） */
  name: string
  path: string
  size: number
  fileCount: number
  /** AI 专清无锁定级，恒为 false（保留字段以复用通用 UI/删除逻辑） */
  locked: boolean
  /** 是否默认勾选 */
  recommend: boolean
}

function hashId(p: string): string {
  return 'ai:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

interface DirStats {
  size: number
  files: number
}

/** 目录遍历的并发数。 */
const WALK_CONC = 8
/** 单目录内 stat 的批量并发数。 */
const STAT_CONC = 32
/** 同时统计体积的目录数（条目级并发）。 */
const DIR_CONC = 10
/** 并发展开待删目录的并发度。 */
const EXPAND_CONC = 12

/**
 * 递归统计目录体积（含文件数）。
 * 两层并发：目录层限并发 8 并行 readdir；文件层批量并发 stat（32），不再逐个 await。
 * 带文件数上限，避免超大目录拖垮扫描。onEntry 每读到一个条目回调一次（驱动进度）。
 */
async function dirStats(
  p: string,
  maxFiles = 20000,
  onEntry?: () => void,
  collect?: ExpandedFile[],
): Promise<DirStats> {
  let size = 0
  let files = 0
  const stack: string[] = [p]
  let idx = 0
  let active = 0
  const worker = async () => {
    for (;;) {
      if (files >= maxFiles) return
      if (idx >= stack.length) {
        if (active === 0) return
        await new Promise((r) => setImmediate(r))
        continue
      }
      active++
      const cur = stack[idx++]
      let ents: fs.Dirent[] = []
      try {
        ents = await fs.promises.readdir(cur, { withFileTypes: true })
      } catch {
        active--
        continue
      }
      const batch: string[] = []
      for (const e of ents) {
        onEntry?.()
        if (files + batch.length >= maxFiles) break
        const fp = path.join(cur, e.name)
        try {
          if (e.isDirectory()) {
            if (SELF_NAMES.has(e.name.toLowerCase())) continue
            stack.push(fp)
          } else if (e.isFile()) {
            batch.push(fp)
          }
        } catch {
          /* 无权限访问，跳过 */
        }
      }
      active--
      for (let i = 0; i < batch.length && files < maxFiles; i += STAT_CONC) {
        const chunk = batch.slice(i, i + STAT_CONC)
        const stats = await Promise.all(
          chunk.map((f) => fs.promises.stat(f).catch(() => null)),
        )
        for (let k = 0; k < chunk.length; k++) {
          const st = stats[k]
          if (!st) continue
          size += st.size
          files++
          if (collect) collect.push({ path: chunk[k], size: st.size })
        }
      }
    }
  }
  await Promise.all(Array.from({ length: WALK_CONC }, () => worker()))
  return { size, files }
}

/** 目录名 → 风险等级；不属于任何已知类别时返回 null（继续下钻）。 */
function levelOfDir(name: string): AiLevel | null {
  const n = name.toLowerCase()
  if (SAFE_DIRS.has(n)) return 'safe'
  if (CAUTION_DIRS.has(n)) return 'caution'
  return null
}

/**
 * AI 缓存流式扫描：async generator，每扫完一个目录条目就即时 yield（边扫边显示）。
 * 与社交专清同构 —— 每积累 16 个扫描条目回吐一次进度，取消时及时中断。
 */
export async function* scanAiCacheStream(
  isCancelled: () => boolean,
  onProgress?: (scanned: number) => void,
): AsyncGenerator<AiCacheItem[], void, unknown> {
  // 新一次扫描：清空上一轮的文件清单缓存（条目与清单必须同源）
  fileListCache.clear()
  dirBlocked.clear()

  let scanned = 0
  const bump = () => {
    scanned++
    if (scanned % 16 === 0) onProgress?.(scanned)
  }

  const drives = await getFixedDrives()
  void drives // AI 软件一般不在其它盘改路径，这里仅保留探测以备扩展
  const sys = systemDrive()
  void sys

  for (const app of AI_APPS) {
    if (isCancelled()) return
    const sysRoots = app.dirs
      .map((d) => expandEnv(d).replace(/\//g, '\\'))
      .filter(Boolean)

    const targets: string[] = []
    for (const root of sysRoots) {
      try {
        if (!fs.existsSync(root)) continue
      } catch {
        continue
      }
      // 根目录本身即已知分类目录（如 cursor-updater 更新缓存）→ 整目录作为一条目
      const rootLevel = levelOfDir(path.basename(root))
      if (rootLevel) {
        targets.push(root)
        continue
      }
      // 深度优先下钻：命中已知类别即成条（不再向内展开），否则继续下钻
      const stack: Array<{ dir: string; depth: number }> = [
        { dir: root, depth: 0 },
      ]
      let cursor = 0
      let active = 0
      const walkWorker = async (): Promise<void> => {
        for (;;) {
          if (isCancelled()) return
          if (cursor >= stack.length) {
            if (active === 0) return
            await new Promise((r) => setImmediate(r))
            continue
          }
          active++
          const cur = stack[cursor++]
          if (cur.depth > 6) {
            active--
            continue
          }
          let ents: fs.Dirent[]
          try {
            ents = await fs.promises.readdir(cur.dir, { withFileTypes: true })
          } catch {
            active--
            continue
          }
          for (const e of ents) {
            if (isCancelled()) return
            bump()
            if (!e.isDirectory()) continue
            const n = e.name.toLowerCase()
            if (SELF_NAMES.has(n)) continue
            const fp = path.join(cur.dir, e.name)
            const lv = levelOfDir(n)
            if (lv === null) {
              stack.push({ dir: fp, depth: cur.depth + 1 })
              continue
            }
            targets.push(fp)
          }
          active--
        }
      }
      await Promise.all(Array.from({ length: WALK_CONC }, () => walkWorker()))
    }

    // 并发统计体积，统计完一个目录就立刻产出一条（边扫边显示）
    const ready: AiCacheItem[] = []
    let cursor = 0
    let finished = false
    let wake: (() => void) | null = null
    const notify = (): void => {
      const w = wake
      wake = null
      if (w) w()
    }

    const worker = async (): Promise<void> => {
      for (;;) {
        if (isCancelled()) return
        const i = cursor++
        if (i >= targets.length) return
        const dir = targets[i]
        const list: ExpandedFile[] = []
        const st = await dirStats(dir, 20000, bump, list)
        if (isCancelled()) return
        const lv = levelOfDir(path.basename(dir)) ?? 'safe'
        if (st.files > 0) {
          if (st.files < 20000) {
            fileListCache.set(dir, list)
            dirBlocked.set(dir, 0)
          }
          ready.push({
            id: hashId(dir),
            app: app.name,
            level: lv,
            name: path.basename(dir),
            path: dir,
            size: st.size,
            fileCount: st.files,
            locked: false,
            recommend: AI_LEVEL_META[lv].recommend,
          })
        }
        notify()
      }
    }

    const workers = Array.from(
      { length: Math.min(DIR_CONC, targets.length) },
      () => worker(),
    )
    void Promise.all(workers).then(() => {
      finished = true
      notify()
    })

    for (;;) {
      if (isCancelled()) return
      if (!ready.length) {
        if (finished) break
        await new Promise<void>((res) => {
          wake = res
        })
        continue
      }
      const item = ready.shift() as AiCacheItem
      yield [item]
      await new Promise((r) => setImmediate(r))
    }
    await new Promise((r) => setImmediate(r))
  }
  if (scanned > 0) onProgress?.(scanned)
}

/** 会话内条目 → 可清理文件清单（展开目录，剔除系统保护文件）。 */
interface ExpandedFile {
  path: string
  size: number
}

/**
 * 扫描阶段顺手缓存的「条目目录 → 可清理文件清单」。
 * 清理时直接复用，避免对勾选项再跑一遍全量递归（微信 FileStorage 那种十万级
 * 目录第二次遍历是清理慢的主因）。只在清单完整（未撞上限）时缓存。
 */
const fileListCache = new Map<string, ExpandedFile[]>()
/** 条目目录 → 不可删文件数（受保护）。为 0 时才能整目录清理。 */
const dirBlocked = new Map<string, number>()

/**
 * 并发展开目录为文件清单（同时收集体积）。限并发 8 异步遍历 + 批量 stat。
 */
async function expandFilesAsync(
  dir: string,
  cap = 20000,
): Promise<{ files: ExpandedFile[]; blocked: number }> {
  const out: ExpandedFile[] = []
  let blocked = 0
  const stack: string[] = [dir]
  let idx = 0
  let active = 0
  const worker = async () => {
    for (;;) {
      if (out.length >= cap) return
      if (idx >= stack.length) {
        if (active === 0) return
        await new Promise((r) => setImmediate(r))
        continue
      }
      active++
      const cur = stack[idx++]
      let ents: fs.Dirent[] = []
      try {
        ents = await fs.promises.readdir(cur, { withFileTypes: true })
      } catch {
        active--
        continue
      }
      const batch: string[] = []
      for (const e of ents) {
        if (out.length + batch.length >= cap) break
        const fp = path.join(cur, e.name)
        try {
          if (e.isDirectory()) {
            if (SELF_NAMES.has(e.name.toLowerCase())) continue
            stack.push(fp)
          } else if (e.isFile()) {
            if (isProtected(fp)) blocked++
            else batch.push(fp)
          }
        } catch {
          /* ignore */
        }
      }
      active--
      for (let i = 0; i < batch.length && out.length < cap; i += STAT_CONC) {
        const chunk = batch.slice(i, i + STAT_CONC)
        const stats = await Promise.all(
          chunk.map((f) => fs.promises.stat(f).catch(() => null)),
        )
        for (let k = 0; k < chunk.length; k++) {
          out.push({ path: chunk[k], size: stats[k]?.size ?? 0 })
        }
      }
    }
  }
  await Promise.all(Array.from({ length: WALK_CONC }, () => worker()))
  return { files: out, blocked }
}

/** 限制并发的 map。 */
async function mapWithConcurrency<T, R>(
  inputs: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(inputs.length)
  let i = 0
  const worker = async () => {
    while (i < inputs.length) {
      const idx = i++
      results[idx] = await fn(inputs[idx])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, () => worker()),
  )
  return results
}

/** 整目录清理的并发数。 */
const DIR_DELETE_CONC = 6

/**
 * 删除 AI 缓存条目（提速版，与社交专清同构）。
 * 条目是「目录」：优先复用扫描缓存的清单（几乎零成本），未命中才展开目录；
 * 目录内无受保护文件时整目录一次性移入回收站（远快于逐文件），否则退回逐文件。
 * 默认进回收站，purge=true 永久删除；受保护路径与自身目录在展开阶段即剔除。
 */
export async function deleteAiCacheItems(
  items: Map<string, AiCacheItem>,
  ids: string[],
  purge: boolean,
  onDeleted?: (ids: string[]) => void,
): Promise<CleanResult> {
  const result: CleanResult = {
    deleted_count: 0,
    deleted_size: 0,
    skipped: [],
    errors: [],
  }
  const auditItems: CleanCandidate[] = []
  const progressBuf: string[] = []
  let lastFlush = 0
  const flushProgress = (force = false) => {
    const now = Date.now()
    if (!progressBuf.length || !onDeleted) return
    if (!force && progressBuf.length < 100 && now - lastFlush < 120) return
    lastFlush = now
    onDeleted(progressBuf.splice(0))
  }

  const fileItem = new Map<string, string>()
  const fileSize = new Map<string, number>()
  const itemFailed = new Set<string>()
  const itemNoFile = new Set<string>()

  const wholePlans: Array<{ id: string; dir: string; files: ExpandedFile[] }> = []

  const expanded = await mapWithConcurrency(ids, EXPAND_CONC, async (id) => {
    const it = items.get(id)
    if (!it) return { id, status: 'missing' as const, files: [] as ExpandedFile[] }
    const cached = fileListCache.get(it.path)
    const got = cached
      ? { files: cached, blocked: dirBlocked.get(it.path) ?? 0 }
      : await expandFilesAsync(it.path)
    return {
      id,
      status: (got.files.length ? 'ok' : 'nofile') as 'ok' | 'nofile',
      files: got.files,
      blocked: got.blocked,
    }
  })
  for (const e of expanded) {
    if (e.status === 'missing') {
      result.skipped.push({ id: e.id, path: '', reason: '条目不在本次扫描会话内' })
      continue
    }
    if (e.status === 'nofile') {
      result.skipped.push({
        id: e.id,
        path: items.get(e.id)?.path ?? '',
        reason: '无可删除文件',
      })
      itemNoFile.add(e.id)
      continue
    }
    const dir = items.get(e.id)?.path ?? ''
    if (e.blocked === 0 && dir && !isProtected(dir)) {
      let ok = true
      for (const f of e.files) {
        if (isProtected(f.path)) {
          ok = false
          itemFailed.add(e.id)
        }
      }
      if (ok) {
        wholePlans.push({ id: e.id, dir, files: e.files })
        continue
      }
    }
    for (const f of e.files) {
      if (isProtected(f.path)) {
        itemFailed.add(e.id)
        continue
      }
      fileItem.set(f.path, e.id)
      fileSize.set(f.path, f.size)
    }
  }

  // 整目录清理（提速）：一次操作移走整棵目录树（含子目录）
  // - purge：并发 rm，不进回收站，无外部进程开销
  // - 回收站：目录按每 8 个一组交给批量接口并多组并发。
  //   原实现「每个目录单独起一次 exe 进程」（COM 初始化开销 × N）是清理慢的主因；
  //   单进程内可一次 COM 会话处理多个目录，但全挤进一个进程又会串行，故分小批并发。
  //   实测：12 目录批量比逐目录并发快约 1.5x，24 目录再分批并发又快约 1.2x。
  //   之后仍逐个 existsSync 判定，未移走的目录回退逐文件清理，语义不变。
  if (wholePlans.length) {
    if (purge) {
      await mapWithConcurrency(wholePlans, DIR_DELETE_CONC, async (p) => {
        try {
          await fs.promises.rm(p.dir, {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 100,
          })
        } catch {
          /* 交给下面的存在性判定处理 */
        }
      })
    } else {
      const DIRS_PER_BATCH = 8
      const dirs = wholePlans.map((p) => p.dir)
      const batches: string[][] = []
      for (let i = 0; i < dirs.length; i += DIRS_PER_BATCH) {
        batches.push(dirs.slice(i, i + DIRS_PER_BATCH))
      }
      await mapWithConcurrency(batches, DIR_DELETE_CONC, (batch) =>
        moveManyToRecycleBin(batch),
      )
    }

    for (const p of wholePlans) {
      let gone = false
      try {
        gone = !fs.existsSync(p.dir)
      } catch {
        gone = true
      }
      if (!gone) {
        for (const f of p.files) {
          if (isProtected(f.path)) {
            itemFailed.add(p.id)
            continue
          }
          fileItem.set(f.path, p.id)
          fileSize.set(f.path, f.size)
        }
        continue
      }
      for (const f of p.files) {
        result.deleted_count += 1
        result.deleted_size += f.size
        auditItems.push({
          id: p.id,
          path: f.path,
          size: f.size,
          category: `AI软件缓存·${items.get(p.id)?.app ?? ''}`,
          rule_id: `aicache:${items.get(p.id)?.level ?? 'safe'}`,
        })
        progressBuf.push(f.path)
      }
      flushProgress()
    }
  }

  const finalizeSkipped = () => {
    for (const id of ids) {
      if (itemNoFile.has(id)) continue
      const it = items.get(id)
      if (!it) continue
      if (itemFailed.has(id)) {
        result.skipped.push({
          id,
          path: it.path,
          reason: '部分文件未删除（可能被占用或受保护）',
        })
      }
    }
  }

  const allFiles = [...fileItem.keys()]
  if (allFiles.length === 0) {
    // 整目录全部成功时没有逐文件阶段，这里必须强制冲刷，否则最后一批进度丢失
    flushProgress(true)
    finalizeSkipped()
    if (auditItems.length) logDeletion(auditItems, purge)
    return result
  }

  if (purge) {
    let pidx = 0
    const CONC = 12
    const worker = async () => {
      while (pidx < allFiles.length) {
        const fp = allFiles[pidx++]
        const itemId = fileItem.get(fp)!
        try {
          try {
            await fs.promises.chmod(fp, 0o666)
          } catch {
            /* 只读属性可能不可改，交 rm 重试兜底 */
          }
          await fs.promises.rm(fp, {
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          })
          const sz = fileSize.get(fp) ?? 0
          result.deleted_count += 1
          result.deleted_size += sz
          auditItems.push({
            id: itemId,
            path: fp,
            size: sz,
            category: `AI软件缓存·${items.get(itemId)?.app ?? ''}`,
            rule_id: `aicache:${items.get(itemId)?.level ?? 'safe'}`,
          })
          progressBuf.push(fp)
          flushProgress()
        } catch (e) {
          itemFailed.add(itemId)
          const code = (e as NodeJS.ErrnoException)?.code
          const msg = e instanceof Error ? e.message : String(e)
          if (
            code === 'EBUSY' ||
            code === 'EPERM' ||
            code === 'EACCES' ||
            code === 'ETXTBSY' ||
            /busy|locked|permitted/i.test(msg)
          ) {
            result.errors.push(`${fp}: 使用中或无权访问，已跳过`)
          } else {
            result.errors.push(`${fp}: ${msg}`)
          }
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONC, allFiles.length) }, () => worker()),
    )
  } else {
    try {
      const succeededPaths = new Set<string>()
      const { succeeded, failed } = await moveManyToRecycleBin(
        allFiles,
        (batch) => {
          for (const p of batch) {
            if (succeededPaths.has(p)) continue
            succeededPaths.add(p)
            const itemId = fileItem.get(p)!
            const sz = fileSize.get(p) ?? 0
            result.deleted_count += 1
            result.deleted_size += sz
            auditItems.push({
              id: itemId,
              path: p,
              size: sz,
              category: `AI软件缓存·${items.get(itemId)?.app ?? ''}`,
              rule_id: `aicache:${items.get(itemId)?.level ?? 'safe'}`,
            })
            progressBuf.push(p)
          }
          flushProgress()
        },
      )
      for (const p of succeeded) {
        if (succeededPaths.has(p)) continue
        succeededPaths.add(p)
        const itemId = fileItem.get(p)!
        const sz = fileSize.get(p) ?? 0
        result.deleted_count += 1
        result.deleted_size += sz
        auditItems.push({
          id: itemId,
          path: p,
          size: sz,
          category: `AI软件缓存·${items.get(itemId)?.app ?? ''}`,
          rule_id: `aicache:${items.get(itemId)?.level ?? 'safe'}`,
        })
        progressBuf.push(p)
      }
      for (const f of failed) {
        const itemId = fileItem.get(f.path)!
        itemFailed.add(itemId)
        result.errors.push(`${f.path}: ${f.error ?? '移入回收站失败'}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      result.errors.push(`回收站删除失败：${msg}`)
      for (const fp of allFiles) itemFailed.add(fileItem.get(fp)!)
    }
  }

  flushProgress(true)
  finalizeSkipped()
  if (auditItems.length) logDeletion(auditItems, purge)
  return result
}
