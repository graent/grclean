/**
 * 社交缓存专清（design.md §3.5 / §3.15）。
 *
 * C 盘的「隐形杀手」。缓存按风险分四级，**聊天记录数据库永久锁死，绝不提供删除入口**：
 *   ① 安全 · 临时缓存（Cache / Temp / Log）  —— 可重建，默认勾选
 *   ② 建议 · 图片缓存（Image / Attach）      —— 通常可释放，默认勾选
 *   ③ 谨慎 · 视频/接收文件（Video / File）   —— 可能还有用，默认不勾
 *   ④ 锁定 · 聊天记录（Msg*.db / *.db）      —— 永久不可选，仅展示体积
 *
 * 定位策略（对应设计的「默认路径自动搜寻，即使已改盘也能找到」）：
 * - 微信 4.x 应用目录 %APPDATA%\Tencent\xwechat（含 log 日志等，log 归「安全」）；
 * - 微信数据目录：3.x 在 Documents\WeChat Files；4.x 改名为 xwechat_files，可能在
 *   用户目录、或在设置里自定义的任意位置（从 Tencent\xwechat\config\*.ini 读取父目录
 *   再拼 xwechat_files）—— 这是 360 同款做法；此外还在每块固定盘的常见位置跨盘探测；
 * - 微博 / 抖音 / YY / 陌陌 / Soul / 千牛 目录命名随版本变动，扫描常见 AppData 目录 best-effort，
 *   未命中即静默跳过（不打扰用户）。
 *
 * 删除防线（比通用清理更严）：
 * 1. 仅接受本次会话内的 `id`，从会话反查真实路径，前端无法注入任意路径；
 * 2. 锁定级条目直接拒绝（不计入清理，界面也不可勾选）；
 * 3. 展开目录时再次按扩展名剔除 `*.db / *.db-wal / *.db-shm`；
 * 4. 每个文件执行期再校验 `isProtected`；
 * 5. 默认移入回收站，purge=true 才永久删除；
 * 6. 成功删除写入审计日志。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { expandEnv } from './rules'
import { isProtected } from './protected'
import { logDeletion } from './audit'
import { runPs } from './ps'
import { moveToRecycleBin } from './trash-bin'
import type { CleanCandidate, CleanResult } from './model'

/** 四级风险。 */
export type SocialLevel = 'safe' | 'advise' | 'caution' | 'locked'

/** 每一级的展示元信息（对齐 §3.15 风险分级总览的颜色与默认行为）。 */
export interface LevelMeta {
  /** 排序（界面分组顺序） */
  order: number
  /** 组标题，如「① 安全 · 临时缓存」 */
  label: string
  /** 组说明 */
  desc: string
  /** 界面色（绿/蓝/橙/红） */
  color: string
  /** 是否默认勾选 */
  recommend: boolean
  /** 是否锁定不可选 */
  locked: boolean
}

export const LEVEL_META: Record<SocialLevel, LevelMeta> = {
  safe: {
    order: 1,
    label: '① 安全 · 临时缓存',
    desc: '可自动重建，放心删（Cache / Temp）',
    color: '#3a9d3a',
    recommend: true,
    locked: false,
  },
  advise: {
    order: 2,
    label: '② 建议 · 图片缓存',
    desc: '通常可释放，软件会按需重新拉取（图片）',
    color: '#5a6acf',
    recommend: true,
    locked: false,
  },
  caution: {
    order: 3,
    label: '③ 谨慎 · 视频/接收文件',
    desc: '可能还有用（聊天视频 / 接收的文件），默认不勾',
    color: '#d98324',
    recommend: false,
    locked: false,
  },
  locked: {
    order: 4,
    label: '④ 锁定 · 聊天记录',
    desc: '永久不可选，绝不提供删除入口（Msg*.db）',
    color: '#d33333',
    recommend: false,
    locked: true,
  },
}

interface SocialApp {
  name: string
  /** 系统盘上的候选根目录（展开 %ENV% 后，不存在则跳过） */
  dirs: string[]
  /**
   * 可识别的数据文件夹名（不含路径）。用于「跨盘扫描」：社交软件的数据目录
   * 不一定在系统盘（用户常在安装时把文件存储位置改到其他盘，或迁移了用户目录），
   * 因此除系统盘外，还在每块固定盘的根目录 / Documents / Users\<用户>\Documents
   * 下按这些名字快速探测。命中即递归下钻。
   */
  reloc: string[]
}

const APPS: SocialApp[] = [
  // 微信：3.x 在 Documents\WeChat Files；4.0（2025 起）把数据目录改名为
  // xwechat_files，且部分安装直接放在用户目录下（不在 Documents 内）。
  // 三处都尝试，命中即扫。
  {
    name: '微信',
    dirs: [
      '%USERPROFILE%\\Documents\\WeChat Files',
      '%USERPROFILE%\\Documents\\xwechat_files',
      '%USERPROFILE%\\xwechat_files',
      // 4.x 应用目录下的日志（Tencent\xwechat\log，归类为「安全 · 日志」）。
      // 注意：只定位到 log，不扫整个 Tencent\xwechat —— 其下的 radium 嵌入式浏览器
      // 运行时缓存（Code Cache / GPUCache 等）与 net 的 CDN 缓存属于微信 app 内部，
      // 并非用户社交缓存，360 也只清 log。
      '%APPDATA%\\Tencent\\xwechat\\log',
    ],
    reloc: ['WeChat Files', 'xwechat_files'],
  },
  { name: 'QQ', dirs: ['%USERPROFILE%\\Documents\\Tencent Files'], reloc: ['Tencent Files'] },
  { name: '钉钉', dirs: ['%USERPROFILE%\\Documents\\DingTalk'], reloc: ['DingTalk'] },
  { name: '企业微信', dirs: ['%USERPROFILE%\\Documents\\WXWork'], reloc: ['WXWork'] },
  { name: '飞书', dirs: ['%LOCALAPPDATA%\\Lark\\SDK'], reloc: ['Lark'] },
  { name: '微博桌面', dirs: ['%APPDATA%\\Weibo'], reloc: ['Weibo'] },
  { name: '抖音聊天', dirs: ['%LOCALAPPDATA%\\Douyin', '%APPDATA%\\Douyin'], reloc: ['Douyin'] },
  { name: 'YY语音', dirs: ['%APPDATA%\\YY'], reloc: ['YY'] },
  { name: '陌陌', dirs: ['%APPDATA%\\Momo'], reloc: ['Momo'] },
  { name: 'Soul', dirs: ['%APPDATA%\\Soul'], reloc: ['Soul'] },
  { name: '千牛', dirs: ['%USERPROFILE%\\Documents\\Qianniu', '%APPDATA%\\Qianniu', '%LOCALAPPDATA%\\Qianniu'], reloc: ['Qianniu'] },
]

/** 系统盘盘符（如 'C'），跨盘扫描时跳过它（系统盘路径已由 dirs 覆盖）。 */
function systemDrive(): string {
  const sd = (process.env.SystemDrive || 'C:').replace(/:$/, '')
  return sd.toUpperCase()
}

/** 当前登录用户名（用于 <盘符>:\Users\<用户>\Documents 这类迁移后的用户目录）。 */
function currentUser(): string {
  return process.env.USERNAME || ''
}

let _wxDataCache: string[] | null = null
let _wxDataPending: Promise<string[]> | null = null

/**
 * 微信 4.x 把「文件存储位置」明文写在 %APPDATA%\Tencent\xwechat\config\*.ini，
 * 每行一个父目录（如 `D:\softs\tengxun\weixindata`）。微信数据目录即 `<父>\xwechat_files`。
 * 这是定位「用户自定义到其他盘」数据的可靠入口（与 360 同款做法），无需扫整盘。
 * 结果模块级缓存；配置不存在（3.x / 未装微信）或读取失败时返回空数组。
 */
async function wechatCustomDataRoots(): Promise<string[]> {
  if (_wxDataCache) return _wxDataCache
  if (_wxDataPending) return _wxDataPending
  _wxDataPending = (async () => {
    const out: string[] = []
    const cfgDir = expandEnv('%APPDATA%\\Tencent\\xwechat\\config').replace(/\//g, '\\')
    try {
      const files = fs
        .readdirSync(cfgDir)
        .filter((f) => f.toLowerCase().endsWith('.ini'))
      for (const f of files) {
        try {
          const line = fs
            .readFileSync(path.join(cfgDir, f), 'utf8')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)[0]
          if (!line) continue
          const dataRoot = path.join(line, 'xwechat_files')
          if (!out.includes(dataRoot)) out.push(dataRoot)
        } catch {
          /* 单文件损坏，跳过 */
        }
      }
    } catch {
      /* 目录不存在（3.x 或没装微信），回退空 */
    }
    _wxDataCache = out
    return out
  })()
  return _wxDataPending
}

let _drivesCache: string[] | null = null
let _drivesPending: Promise<string[]> | null = null

/**
 * 列出本机所有「固定本地盘」盘符（C/D/E…），结果模块级缓存，避免每次扫描都拉起
 * PowerShell。仅含 Fixed 类型（排除 U 盘 / 网络盘），既贴合「改到其他本地盘」的真实
 * 场景，也避免网络盘 existsSync 超时拖慢扫描。
 */
async function getFixedDrives(): Promise<string[]> {
  if (_drivesCache) return _drivesCache
  if (_drivesPending) return _drivesPending
  _drivesPending = (async () => {
    try {
      const out = await runPs(
        "Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | Where-Object { $_.DriveType -eq 'Fixed' } | ForEach-Object { $_.Name }",
      )
      const letters = out
        .split(/\r?\n/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z]$/.test(s))
      if (letters.length) {
        _drivesCache = letters
        return letters
      }
    } catch {
      /* ignore，回退 C */
    }
    _drivesCache = ['C']
    return _drivesCache
  })()
  return _drivesPending
}

/**
 * 为某款软件生成「非系统盘」上的候选根目录。社交软件的数据常被改到其他盘，因此除
 * 系统盘（由 dirs 覆盖）外，还在每块固定盘的根目录 / Documents / Users\<用户>\Documents
 * 下按 reloc 名字探测，命中即递归下钻。所有路径去重。
 */
function crossDriveRoots(
  app: SocialApp,
  drives: string[],
  sys: string,
  user: string,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of drives) {
    if (d === sys) continue
    for (const r of app.reloc) {
      const cands = [
        `${d}:\\${r}`,
        `${d}:\\Documents\\${r}`,
        user ? `${d}:\\Users\\${user}\\Documents\\${r}` : '',
      ]
      for (const c of cands) {
        if (c && !seen.has(c)) {
          seen.add(c)
          out.push(c)
        }
      }
    }
  }
  return out
}

/** ① 安全：临时缓存类目录名（小写比对）。 */
const SAFE_DIRS = new Set([
  'cache',
  'caches',
  'cacheData',
  'cachedata',
  'temp',
  'tmp',
  'gpucache',
  'code cache',
  'blob_storage',
  'session storage',
  'shadercache',
  'crashpad',
  'logs',
  'log',
])

/** ② 建议：图片类缓存目录名（默认勾选）。 */
const ADVISE_DIRS = new Set([
  'image',
  'images',
  'pic',
  'pics',
  'thumb',
  'thumbs',
  'thumbnail',
  'thumbnails',
  'media',
  'attach', // 微信 4.x：msg/attach 下的加密图片（.dat），属图片缓存
])

/** ③ 谨慎：视频 / 接收文件 / 表情类目录名（默认不勾）。
 * 微信 4.x 的 msg/video（聊天视频）、msg/file（接收的文件）归此类，需用户自行决定是否清理。 */
const CAUTION_DIRS = new Set([
  'filerecv',
  'file',
  'files',
  'video', // 微信 4.x：msg/video（聊天视频）—— 可能想保留，默认不勾
  'videos',
  'download',
  'downloads',
  'customemotions',
  'customemotion',
  'emoji',
  'emotion',
  'sticker',
  'favorite',
  'favorites',
])

/** ④ 锁定：聊天记录目录名（整体锁死，不展开、不统计为可清理）。
 * 注意：历史上把 'msg' 整目录当作锁定（仅 3.x 如此，里面只放聊天库）。
 * 微信 4.x 把聊天库(.db)与接收的 文件/图片/视频 都放进 msg/ 下，因此不再整体锁
 * msg，改为靠 LOCKED_EXT(.db/.sqlite…) 逐文件锁死聊天库，同时让 msg/file、
 * msg/attach、msg/video 这些缓存子目录可被扫描清理。 */
const LOCKED_DIRS = new Set([
  'msgdb',
  'msgstorage',
  'databases',
  'database',
  'db',
  'dbstorage',
  'message',
  'messages',
])

/** 聊天记录数据库扩展名 —— 任何情况下都不删除。
 * 注意：不含 .dat。微信 4.x / QQ 的缓存图片以加密 .dat 形式存放，属于「图片
 * 缓存」应可被清理；真正的聊天记录在 .db 里，由本集合锁死。 */
const LOCKED_EXT = /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i

/** 不展开、不统计的目录（既不是用户缓存，也不是聊天库，扫了只会误伤/虚高）。
 * - backup：微信聊天记录「备份」文件夹，误清会丢失备份；
 * - all_users：多用户共享数据；
 * - migrate：版本迁移临时目录。 */
const SKIP_DIRS = new Set(['backup', 'all_users', 'migrate'])

export interface SocialItem {
  id: string
  /** 应用名，如「微信」 */
  app: string
  level: SocialLevel
  /** 条目名（目录名或锁定组名） */
  name: string
  path: string
  size: number
  fileCount: number
  /** 锁定级：界面不可勾选，后端也拒绝删除 */
  locked: boolean
  /** 是否默认勾选 */
  recommend: boolean
}

function hashId(p: string): string {
  return 'soc:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

interface DirStats {
  size: number
  files: number
}

/**
 * 递归统计目录体积，并按需剔除聊天记录库。
 * 带文件数上限，避免超大目录（如多年微信 FileStorage）拖垮扫描。
 */
function dirStats(
  p: string,
  skipLockedExt: boolean,
  maxFiles = 20000,
  skipDirs?: Set<string>,
): DirStats {
  let size = 0
  let files = 0
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
        if (e.isDirectory()) {
          if (skipDirs && skipDirs.has(e.name.toLowerCase())) continue
          stack.push(fp)
        } else if (e.isFile()) {
          if (skipLockedExt && LOCKED_EXT.test(e.name)) continue
          size += fs.statSync(fp).size
          files++
        }
      } catch {
        /* 无权限访问，跳过 */
      }
    }
  }
  return { size, files }
}

/** 目录名 → 风险等级；不属于任何已知类别时返回 null（继续下钻）。 */
function levelOfDir(name: string): SocialLevel | null {
  const n = name.toLowerCase()
  if (LOCKED_DIRS.has(n)) return 'locked'
  if (SAFE_DIRS.has(n)) return 'safe'
  if (ADVISE_DIRS.has(n)) return 'advise'
  if (CAUTION_DIRS.has(n)) return 'caution'
  return null
}

/**
 * 社交缓存流式扫描：async generator，每扫完一款应用 yield 一批。
 * 与垃圾清理同构 —— 每批之间 `setImmediate` 让权，取消时及时中断。
 */
export async function* scanSocialStream(
  isCancelled: () => boolean,
): AsyncGenerator<SocialItem[], void, unknown> {
  const drives = await getFixedDrives()
  const sys = systemDrive()
  const user = currentUser()
  for (const app of APPS) {
    if (isCancelled()) return
    const items: SocialItem[] = []
    const lockedAgg = { size: 0, files: 0 }

    // 系统盘路径（dirs） + 其它固定盘的跨盘探测路径，合并去重后逐根扫描
    const sysRoots = app.dirs
      .map((d) => expandEnv(d).replace(/\//g, '\\'))
      .filter(Boolean)
    const roots = Array.from(
      new Set([
        ...sysRoots,
        ...crossDriveRoots(app, drives, sys, user),
        // 微信：用户在设置里自定义的任意数据盘（从 config\*.ini 读取）
        ...(app.name === '微信' ? await wechatCustomDataRoots() : []),
      ]),
    )

    for (const root of roots) {
      try {
        if (!fs.existsSync(root)) continue
      } catch {
        continue
      }

      // 若根目录本身就是一个已知分类目录（如 Tencent\xwechat\log），整目录作为
      // 一条目（含其下的零散文件，例如 .xlog 日志），不再向内下钻，避免漏项/重复。
      const rootLevel = levelOfDir(path.basename(root))
      if (rootLevel && rootLevel !== 'locked') {
        const st = dirStats(root, true)
        if (st.files > 0) {
          items.push({
            id: hashId(root),
            app: app.name,
            level: rootLevel,
            name: path.basename(root),
            path: root,
            size: st.size,
            fileCount: st.files,
            locked: false,
            recommend: LEVEL_META[rootLevel].recommend,
          })
        }
        continue
      }

      // 深度优先下钻：命中已知类别即成条（不再向内展开），否则继续下钻
      // （例如 FileStorage 本身无类别，其下的 Image / Video / Cache 才是条目）
      const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
      while (stack.length) {
        if (isCancelled()) return
        const cur = stack.pop() as { dir: string; depth: number }
        if (cur.depth > 6) continue
        let ents: fs.Dirent[]
        try {
          ents = fs.readdirSync(cur.dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const e of ents) {
          if (isCancelled()) return
          const fp = path.join(cur.dir, e.name)
          const n = e.name.toLowerCase()

          // 聊天记录库文件：只累计体积，绝不生成可清理条目
          if (e.isFile()) {
            if (LOCKED_EXT.test(e.name)) {
              try {
                lockedAgg.size += fs.statSync(fp).size
                lockedAgg.files += 1
              } catch {
                /* ignore */
              }
            }
            continue
          }
          if (!e.isDirectory()) continue

          // 备份 / 共享 / 迁移数据：不展开、不统计（误清会丢聊天记录备份）
          if (SKIP_DIRS.has(n)) continue

          const lv = levelOfDir(n)
          if (lv === 'locked') {
            const st = dirStats(fp, false)
            lockedAgg.size += st.size
            lockedAgg.files += st.files
            continue
          }
          if (lv === null) {
            stack.push({ dir: fp, depth: cur.depth + 1 })
            continue
          }
          // 可清理条目：统计体积时剔除聊天记录库
          const st = dirStats(fp, true)
          if (st.files === 0) continue
          items.push({
            id: hashId(fp),
            app: app.name,
            level: lv,
            name: e.name,
            path: fp,
            size: st.size,
            fileCount: st.files,
            locked: false,
            recommend: LEVEL_META[lv].recommend,
          })
        }
        await new Promise((r) => setImmediate(r))
      }
    }

    // 锁定组：每款应用汇总为一条，仅展示体积
    if (lockedAgg.files > 0) {
      items.push({
        id: hashId(`${app.name}::locked`),
        app: app.name,
        level: 'locked',
        name: '聊天记录数据库',
        path: `${app.name}（Msg*.db 等，永久锁死）`,
        size: lockedAgg.size,
        fileCount: lockedAgg.files,
        locked: true,
        recommend: false,
      })
    }

    if (items.length) {
      items.sort((a, b) => b.size - a.size)
      yield items
    }
    await new Promise((r) => setImmediate(r))
  }
}

/** 会话内条目 → 可清理文件清单（展开目录，剔除聊天记录库）。 */
function expandFiles(item: SocialItem): string[] {
  const out: string[] = []
  const stack: string[] = [item.path]
  const cap = 20000
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
        else if (e.isFile() && !LOCKED_EXT.test(e.name)) out.push(fp)
      } catch {
        /* ignore */
      }
    }
  }
  return out
}

/**
 * 删除社交缓存条目。
 *
 * 与通用 `deleteCandidates` 的区别：条目是「目录」而非单文件，这里按目录展开；
 * 锁定级条目与聊天记录库在展开阶段即被剔除，从机制上保证不可删。
 */
export async function deleteSocialItems(
  items: Map<string, SocialItem>,
  ids: string[],
  purge: boolean,
): Promise<CleanResult> {
  const result: CleanResult = {
    deleted_count: 0,
    deleted_size: 0,
    skipped: [],
    errors: [],
  }
  // 移入回收站：经 trash-bin 定位 windows-trash.exe 直接执行
  // （不再直接用 trash 包，避免打包后 import.meta.url 解析失败）
  const auditItems: CleanCandidate[] = []

  for (const id of ids) {
    const item = items.get(id)
    if (!item) {
      result.skipped.push({ id, path: '', reason: '条目不在本次扫描会话内' })
      continue
    }
    // 防线 1：锁定级一律拒绝
    if (item.locked || item.level === 'locked') {
      result.skipped.push({ id, path: item.path, reason: '聊天记录已锁定，禁止清理' })
      continue
    }
    const files = expandFiles(item)
    for (const fp of files) {
      // 防线 2：受保护路径
      if (isProtected(fp)) {
        result.skipped.push({ id, path: fp, reason: '受保护路径，已拦截' })
        continue
      }
      // 防线 3：聊天记录库扩展名（双保险）
      if (LOCKED_EXT.test(fp)) {
        result.skipped.push({ id, path: fp, reason: '聊天记录数据库，已拦截' })
        continue
      }
      let size = 0
      try {
        size = fs.statSync(fp).size
      } catch {
        /* 可能已被删除 */
      }
      try {
        if (purge) fs.unlinkSync(fp)
        else await moveToRecycleBin(fp)
        result.deleted_count += 1
        result.deleted_size += size
        auditItems.push({
          id,
          path: fp,
          size,
          category: `社交软件缓存·${item.app}`,
          rule_id: `social:${item.level}`,
        })
      } catch (e) {
        result.errors.push(`${fp}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  if (auditItems.length) logDeletion(auditItems, purge)
  return result
}

export interface SocialCacheSize {
  totalBytes: number
  byApp: Record<string, number>
}

/** 只读体积统计（健康评分的「社交缓存体积」因素使用，不产出条目）。 */
export async function scanSocialCacheSize(): Promise<SocialCacheSize> {
  const byApp: Record<string, number> = {}
  let total = 0
  const drives = await getFixedDrives()
  const sys = systemDrive()
  const user = currentUser()
  for (const app of APPS) {
    let size = 0
    const sysRoots = app.dirs
      .map((d) => expandEnv(d).replace(/\//g, '\\'))
      .filter(Boolean)
    const roots = Array.from(
      new Set([
        ...sysRoots,
        ...crossDriveRoots(app, drives, sys, user),
        ...(app.name === '微信' ? await wechatCustomDataRoots() : []),
      ]),
    )
    for (const ep of roots) {
      try {
        if (!fs.existsSync(ep)) continue
      } catch {
        continue
      }
      // 排除 Backup / all_users / migrate，它们不是用户缓存（备份不该计入社交缓存体积）
      size += dirStats(ep, false, 20000, SKIP_DIRS).size
    }
    byApp[app.name] = size
    total += size
  }
  return { totalBytes: total, byApp }
}
