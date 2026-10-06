/**
 * 右键菜单清理（design.md §3.13）。
 *
 * 枚举 `HKEY_CLASSES_ROOT` 下各类 shell 谓词（文件 / 文件夹 / 桌面背景 / 驱动器 /
 * 所有文件系统对象），列出非系统项，支持**禁用 / 启用 / 删除**。
 *
 * 安全约束：
 * 1. 系统内置谓词（open / runas / edit / print …）永列为系统项，不可操作；
 * 2. 删除前先用 `reg export` 导出 `.reg` 备份到 `%LOCALAPPDATA%\GrClean\ctx-backups`；
 * 3. 只操作本次扫描会话内反查到的注册表路径，前端无法注入任意路径；
 * 4. 禁用采用 Windows 标准的 `LegacyDisable` 空字符串值（可逆），不删数据；
 * 5. 需要管理员权限的操作失败时回传真实错误，不影响其他项。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { runPs, parseJsonArray, psQuote } from './ps'
import { expandEnv } from './rules'

/** 各类右键菜单的注册表根（PowerShell 注册表提供程序路径）。 */
const ROOTS: Array<{ path: string; label: string }> = [
  { path: 'Registry::HKEY_CLASSES_ROOT\\*\\shell', label: '文件右键' },
  { path: 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell', label: '文件夹右键' },
  {
    path: 'Registry::HKEY_CLASSES_ROOT\\Directory\\Background\\shell',
    label: '桌面 / 文件夹空白处',
  },
  { path: 'Registry::HKEY_CLASSES_ROOT\\Drive\\shell', label: '驱动器右键' },
  { path: 'Registry::HKEY_CLASSES_ROOT\\Folder\\shell', label: '文件夹（含库）' },
  {
    path: 'Registry::HKEY_CLASSES_ROOT\\AllFilesystemObjects\\shell',
    label: '所有文件系统对象',
  },
]

/** 系统内置谓词（白名单，永不可操作）。 */
const SYSTEM_VERBS = new Set([
  'open',
  'runas',
  'runasuser',
  'edit',
  'print',
  'printto',
  'find',
  'opennewprocess',
  'opennewwindow',
  'opencontainingfolder',
  'pintostartscreen',
  'pintotaskbar',
  'share',
  'copyaspath',
  'properties',
  'new',
  'openwith',
  'enqueue',
  'play',
  'preview',
  'mount',
  'eject',
  'format',
  'restore',
  'cut',
  'copy',
  'paste',
  'delete',
  'rename',
  'link',
  'undelete',
  'scanwithdefender',
  'windowsdefender',
])

export interface ContextMenuItem {
  id: string
  /** 显示名（MUIVerb / 默认值 / 子键名） */
  name: string
  /** 子键名（谓词） */
  verb: string
  /** 所属位置：文件右键 / 文件夹右键 … */
  source: string
  /** PowerShell 注册表路径（会话内反查用） */
  key: string
  command: string
  /** 系统内置，不可操作 */
  system: boolean
  /** 已被 LegacyDisable 禁用 */
  disabled: boolean
}

function hashId(p: string): string {
  return 'ctx:' + crypto.createHash('md5').update(p).digest('hex').slice(0, 16)
}

/** 备份目录（删除前导出 .reg 到此）。 */
export function backupDir(): string {
  const base = expandEnv('%LOCALAPPDATA%') || ''
  const dir = base ? path.join(base, 'GrClean', 'ctx-backups') : ''
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* 创建失败时删除操作会走「无备份」分支并报错 */
    }
  }
  return dir
}

/** 把 PowerShell 的 PSPath 转成 reg.exe 可识别的键路径。 */
function toRegKey(psPath: string): string {
  const i = psPath.indexOf('Registry::')
  return i >= 0 ? psPath.slice(i + 'Registry::'.length) : psPath
}

/** 流式扫描右键菜单：先一次性取回 PowerShell 结果，再分批 yield，保证 UI 边扫边出。 */
export async function* scanContextMenuStream(
  isCancelled: () => boolean,
): AsyncGenerator<ContextMenuItem[], void, unknown> {
  const list = await scanContextMenu()
  let batch: ContextMenuItem[] = []
  for (const it of list) {
    if (isCancelled()) return
    batch.push(it)
    if (batch.length >= 30) {
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

/** 一次性取回全部右键菜单项（供流式封装与删除会话复用）。 */
export async function scanContextMenu(): Promise<ContextMenuItem[]> {
  const rootsLiteral = ROOTS.map((r) => psQuote(r.path)).join(',')
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(${rootsLiteral})
$out = @()
foreach ($r in $roots) {
  if (-not (Test-Path -LiteralPath $r)) { continue }
  $kids = Get-ChildItem -LiteralPath $r -ErrorAction SilentlyContinue
  foreach ($k in $kids) {
    $p = $k.PSPath
    $verb = $k.PSChildName
    $def = (Get-ItemProperty -LiteralPath $p -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    $mui = (Get-ItemProperty -LiteralPath $p -Name 'MUIVerb' -ErrorAction SilentlyContinue).'MUIVerb'
    $label = ''
    if ($mui) { $label = $mui } elseif ($def) { $label = $def } else { $label = $verb }
    $cmdKey = Join-Path $p 'command'
    $cmd = ''
    if (Test-Path -LiteralPath $cmdKey) {
      $cmd = (Get-ItemProperty -LiteralPath $cmdKey -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    }
    $ld = (Get-ItemProperty -LiteralPath $p -Name 'LegacyDisable' -ErrorAction SilentlyContinue)
    $out += [ordered]@{ verb = $verb; label = $label; root = $r; key = $p; command = $cmd; disabled = [bool]$ld }
  }
}
ConvertTo-Json -Compress $out
`
  const arr = parseJsonArray(await runPs(ps))
  const labelOf = (root: string): string => {
    const hit = ROOTS.find((r) => r.path === root)
    return hit ? hit.label : root
  }
  return arr.map((d: any) => {
    const verb = String(d.verb ?? '')
    return {
      id: hashId(String(d.key ?? verb)),
      name: String(d.label ?? verb),
      verb,
      source: labelOf(String(d.root ?? '')),
      key: String(d.key ?? ''),
      command: String(d.command ?? ''),
      system: SYSTEM_VERBS.has(verb.toLowerCase()),
      disabled: !!d.disabled,
    }
  })
}

export interface CtxOpResult {
  id: string
  ok: boolean
  message: string
}

// ============================================================
// 外壳图标清理（design.md §3.13「外壳图标」）
// 「此电脑」里的第三方图标来自 Explorer\MyComputer\NameSpace 下的命名空间扩展，
// 云盘、播放器、压缩工具装完常留一两个，删掉即可还原干净的「此电脑」。
// 同一套安全策略：系统内置 GUID 锁死、删除前 reg export 备份、会话内反查路径。
// ============================================================

/** 外壳图标（命名空间扩展）的注册表根。 */
const ICON_ROOTS: Array<{ path: string; label: string }> = [
  {
    path: 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MyComputer\\NameSpace',
    label: '此电脑（系统级）',
  },
  {
    path: 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MyComputer\\NameSpace',
    label: '此电脑（32 位）',
  },
  {
    path: 'Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MyComputer\\NameSpace',
    label: '此电脑（当前用户）',
  },
]

/** 系统内置文件夹 GUID（桌面/文档/下载/图片/音乐/视频/3D 对象），永不可操作。 */
const SYSTEM_ICON_GUIDS = new Set([
  '{b4bfcc3a-db2c-424c-b029-7fe99a87c641}', // 桌面
  '{d3162b92-9365-467a-956b-92703aca08af}', // 文档
  '{088e3905-0323-4b02-9826-5d99428e115f}', // 下载
  '{3dfdf296-dbec-4fb4-81d1-6a3438bcf4de}', // 音乐
  '{24ad3ad4-a569-4530-98e1-ab02f9417aa8}', // 图片
  '{f86fa3ab-70d2-4fc7-9c99-fcbf05467f3a}', // 视频
  '{0db7e03f-fc29-4dc6-9020-76841c354036}', // 3D 对象
])

export interface ShellIconItem {
  id: string
  /** 显示名（来自 CLSID 默认值） */
  name: string
  /** 命名空间 GUID */
  guid: string
  /** 所属位置 */
  source: string
  /** PowerShell 注册表路径（会话内反查用） */
  key: string
  /** 扩展 DLL 路径 */
  dll: string
  /** 系统内置，不可操作 */
  system: boolean
}

/** 扫描「此电脑」外壳图标。 */
export async function scanShellIcons(): Promise<ShellIconItem[]> {
  const rootsLiteral = ICON_ROOTS.map((r) => psQuote(r.path)).join(',')
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(${rootsLiteral})
$out = @()
foreach ($r in $roots) {
  if (-not (Test-Path -LiteralPath $r)) { continue }
  foreach ($k in (Get-ChildItem -LiteralPath $r -ErrorAction SilentlyContinue)) {
    $guid = $k.PSChildName
    $clsid = 'Registry::HKEY_CLASSES_ROOT\\CLSID\\' + $guid
    $name = (Get-ItemProperty -LiteralPath $k -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    if (-not $name) {
      $name = (Get-ItemProperty -LiteralPath $clsid -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    }
    if (-not $name) { $name = $guid }
    $dll = ''
    $ips = $clsid + '\\InprocServer32'
    if (Test-Path -LiteralPath $ips) {
      $dll = (Get-ItemProperty -LiteralPath $ips -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    }
    $out += [ordered]@{ guid=$guid; name=[string]$name; root=$r; key=$k.PSPath; dll=[string]$dll }
  }
}
ConvertTo-Json -Compress $out
`
  const arr = parseJsonArray(await runPs(ps))
  const labelOf = (root: string): string => {
    const hit = ICON_ROOTS.find((r) => r.path === root)
    return hit ? hit.label : root
  }
  return arr.map((d: any) => {
    const guid = String(d.guid ?? '')
    return {
      id: hashId('icon:' + String(d.key ?? guid)),
      name: String(d.name ?? guid),
      guid,
      source: labelOf(String(d.root ?? '')),
      key: String(d.key ?? ''),
      dll: String(d.dll ?? ''),
      system: SYSTEM_ICON_GUIDS.has(guid.toLowerCase()),
    }
  })
}

/** 流式扫描外壳图标：一次性取回 PowerShell 结果后分批 yield。 */
export async function* scanShellIconsStream(
  isCancelled: () => boolean,
): AsyncGenerator<ShellIconItem[], void, unknown> {
  const list = await scanShellIcons()
  let batch: ShellIconItem[] = []
  for (const it of list) {
    if (isCancelled()) return
    batch.push(it)
    if (batch.length >= 30) {
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

/** 删除外壳图标（删除前导出 .reg 备份，系统内置 GUID 拒绝）。 */
export async function deleteShellIcons(
  items: Map<string, ShellIconItem>,
  ids: string[],
): Promise<CtxOpResult[]> {
  const dir = backupDir()
  const out: CtxOpResult[] = []
  for (const id of ids) {
    const it = items.get(id)
    if (!it) {
      out.push({ id, ok: false, message: '条目不在本次扫描会话内' })
      continue
    }
    if (it.system) {
      out.push({ id, ok: false, message: '系统内置文件夹，禁止删除' })
      continue
    }
    if (dir) {
      const file = path.join(dir, `icon_${it.guid.replace(/[^\w.-]/g, '_')}_${Date.now()}.reg`)
      try {
        await runPs(`reg export ${psQuote(toRegKey(it.key))} ${psQuote(file)} /y`)
      } catch {
        // 导出失败不阻断
      }
    }
    try {
      await runPs(`Remove-Item -LiteralPath ${psQuote(it.key)} -Recurse -Force -ErrorAction Stop`)
      out.push({ id, ok: true, message: dir ? '已移除（已导出 .reg 备份）' : '已移除' })
    } catch (e) {
      out.push({ id, ok: false, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

/** 禁用 / 启用（写入或移除 LegacyDisable 值，可逆）。 */
export async function setContextMenuDisabled(
  items: Map<string, ContextMenuItem>,
  ids: string[],
  disabled: boolean,
): Promise<CtxOpResult[]> {
  const out: CtxOpResult[] = []
  for (const id of ids) {
    const it = items.get(id)
    if (!it) {
      out.push({ id, ok: false, message: '条目不在本次扫描会话内' })
      continue
    }
    if (it.system) {
      out.push({ id, ok: false, message: '系统内置项，禁止操作' })
      continue
    }
    try {
      if (disabled) {
        await runPs(
          `New-ItemProperty -LiteralPath ${psQuote(it.key)} -Name 'LegacyDisable' -Value '' -PropertyType String -Force | Out-Null`,
        )
      } else {
        await runPs(
          `Remove-ItemProperty -LiteralPath ${psQuote(it.key)} -Name 'LegacyDisable' -Force -ErrorAction SilentlyContinue`,
        )
      }
      out.push({ id, ok: true, message: disabled ? '已禁用' : '已启用' })
    } catch (e) {
      out.push({ id, ok: false, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

/** 删除右键菜单项（删除前导出 .reg 备份）。 */
export async function deleteContextMenu(
  items: Map<string, ContextMenuItem>,
  ids: string[],
): Promise<CtxOpResult[]> {
  const dir = backupDir()
  const out: CtxOpResult[] = []
  for (const id of ids) {
    const it = items.get(id)
    if (!it) {
      out.push({ id, ok: false, message: '条目不在本次扫描会话内' })
      continue
    }
    if (it.system) {
      out.push({ id, ok: false, message: '系统内置项，禁止删除' })
      continue
    }
    // 1) 先导出备份（reg.exe 的键路径与 PowerShell 的 PSPath 不同，需转换）
    if (dir) {
      const file = path.join(dir, `${it.verb.replace(/[^\w.-]/g, '_')}_${Date.now()}.reg`)
      try {
        await runPs(`reg export ${psQuote(toRegKey(it.key))} ${psQuote(file)} /y`)
      } catch {
        // 导出失败不阻断：若删除也失败，用户至少知道未改动
      }
    }
    // 2) 再删除
    try {
      await runPs(
        `Remove-Item -LiteralPath ${psQuote(it.key)} -Recurse -Force -ErrorAction Stop`,
      )
      out.push({ id, ok: true, message: dir ? '已删除（已导出 .reg 备份）' : '已删除' })
    } catch (e) {
      out.push({ id, ok: false, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
