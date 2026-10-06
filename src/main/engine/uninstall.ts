import { spawn } from 'child_process'
import { type UninstallEntry, type UninstallResult } from './model'
import { runPs, psQuote, parseJsonArray } from './ps'

interface UninstallRow {
  root: string
  view: string
  key: string
  name: string
  version: string
  publisher: string
  install_location: string
  size_kb: number
  uninstall_string: string
  quiet_uninstall_string: string
  no_remove: number
}

/**
 * 扫描已安装程序（与「控制面板 → 程序和功能」同源）。
 * 覆盖 HKCU、HKLM 64 位与 HKLM 32 位（WOW6432Node）视图；
 * 过滤无显示名称、系统组件、父组件子项及安全更新/补丁类条目，减少噪音。
 */
async function collectRows(): Promise<UninstallRow[]> {
  const script = `
$roots = @(
  @{ r='HKCU'; v='64'; p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  @{ r='HKLM'; v='64'; p='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  @{ r='HKLM'; v='32'; p='HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' }
)
$out = @()
foreach ($t in $roots) {
  $subs = Get-ChildItem -Path $t.p -ErrorAction SilentlyContinue
  foreach ($s in $subs) {
    $k = Get-ItemProperty -LiteralPath $s.PSPath -ErrorAction SilentlyContinue
    if (-not $k) { continue }
    $dn = [string]$k.DisplayName
    if ($dn.Trim() -eq '') { continue }
    if ([int]$k.SystemComponent -eq 1) { continue }
    if ([string]$k.ParentDisplayName -ne '') { continue }
    $rt = ([string]$k.ReleaseType).ToLower()
    if ($rt -eq 'security update' -or $rt -eq 'update' -or $rt -eq 'hotfix') { continue }
    $out += [PSCustomObject]@{
      root=$t.r; view=$t.v; key=$s.PSChildName; name=$dn
      version=[string]$k.DisplayVersion
      publisher=[string]$k.Publisher
      install_location=[string]$k.InstallLocation
      size_kb=[int64]$k.EstimatedSize
      uninstall_string=[string]$k.UninstallString
      quiet_uninstall_string=[string]$k.QuietUninstallString
      no_remove=[int]$k.NoRemove
    }
  }
}
ConvertTo-Json -InputObject ([object[]]$out) -Depth 4 -Compress
`
  return parseJsonArray(await runPs(script)) as UninstallRow[]
}

function toEntry(r: UninstallRow): UninstallEntry {
  const uninstallString = r.uninstall_string ?? ''
  const noRemove = r.no_remove === 1
  return {
    // id 编码 root|view|keyname，卸载时后端据此反查注册表，杜绝命令注入
    id: `${r.root}|${r.view}|${r.key}`,
    name: r.name ?? '',
    version: r.version ?? '',
    publisher: r.publisher ?? '',
    install_location: r.install_location ?? '',
    size_kb: Number(r.size_kb) || 0,
    uninstall_string: uninstallString,
    quiet_uninstall_string: r.quiet_uninstall_string ?? '',
    can_uninstall: !noRemove && uninstallString.trim() !== '',
  }
}

/** 汇总已安装程序（按名称升序，与 Tauri 版一致）。 */
export async function collectUninstallEntries(): Promise<UninstallEntry[]> {
  const rows = await collectRows()
  return rows
    .map(toEntry)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

/** 已安装程序流式扫描：分批 yield（批间让权），前端从上方逐行增加。 */
export async function* scanUninstallStream(
  isCancelled: () => boolean,
): AsyncGenerator<UninstallEntry[], void, unknown> {
  const all = await collectUninstallEntries()
  let batch: UninstallEntry[] = []
  for (const e of all) {
    if (isCancelled()) return
    batch.push(e)
    if (batch.length >= 10) {
      yield batch
      batch = []
      await new Promise((r) => setImmediate(r))
    }
  }
  if (batch.length) yield batch
}

/** 从注册表重新读取某项的卸载命令（后端反查，前端无法注入）。 */
async function readUninstallCommands(
  root: string,
  view: string,
  key: string,
): Promise<{ normal: string; quiet: string }> {
  const dir =
    root === 'HKLM' && view === '32'
      ? 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      : `${root}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`
  const script = `
$k = Get-ItemProperty -LiteralPath (Join-Path ${psQuote(dir)} ${psQuote(
    key,
  )}) -ErrorAction Stop
ConvertTo-Json -InputObject ([PSCustomObject]@{ normal=[string]$k.UninstallString; quiet=[string]$k.QuietUninstallString }) -Compress
`
  const parsed = parseJsonArray(await runPs(script))
  const first = parsed[0] ?? {}
  return { normal: String(first.normal ?? ''), quiet: String(first.quiet ?? '') }
}

/**
 * MsiExec 的卸载字符串偶尔写成 `/I{GUID}`（修改/修复对话框），
 * 必须转为 `/X{GUID}` 才能真正卸载。
 */
function normalizeMsi(s: string): string {
  const lower = s.toLowerCase()
  if (!lower.includes('msiexec') || !lower.includes('/i')) return s
  const pos = lower.indexOf('/i')
  if (pos < 0) return s
  const chars = s.split('')
  if (chars[pos + 1]) chars[pos + 1] = 'X'
  return chars.join('')
}

/**
 * 触发某个程序的原生卸载程序。
 * 卸载命令由后端从注册表重新读取，前端仅传 id；仅启动、不等待其结束。
 */
export async function uninstallProgram(
  id: string,
  quiet: boolean,
): Promise<UninstallResult> {
  const parts = id.split('|')
  if (parts.length < 3) {
    return { launched: false, command: '', error: '无法识别的卸载项 id' }
  }
  const root = parts[0]
  const view = parts[1]
  const key = parts.slice(2).join('|')

  let cmds: { normal: string; quiet: string }
  try {
    cmds = await readUninstallCommands(root, view, key)
  } catch (e) {
    return {
      launched: false,
      command: '',
      error: `读取卸载命令失败: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const cmd =
    quiet && cmds.quiet.trim() ? cmds.quiet : cmds.normal
  if (!cmd.trim()) {
    return { launched: false, command: '', error: '该项没有可用的卸载命令' }
  }
  const finalCmd = normalizeMsi(cmd)

  try {
    // 卸载程序自带 UI，spawn 后不等待结束
    const child = spawn('cmd', ['/C', finalCmd], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return { launched: true, command: finalCmd, error: null }
  } catch (e) {
    return {
      launched: false,
      command: finalCmd,
      error: `启动卸载程序失败: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
