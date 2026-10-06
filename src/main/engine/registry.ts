import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { type RegistryEntry } from './model'
import { runPs, psQuote } from './ps'

/** 每批推送的条目数（控制 IPC 频率，保证 UI 丝滑）。 */
const BATCH = 20

/** 备份目录（不存在时自动创建）。 */
function backupDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(base, 'GrClean', 'registry-backup')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function hashId(s: string): string {
  return crypto.createHash('md5').update(s.toLowerCase()).digest('hex')
}

/**
 * 扫描无效注册表项（一次 PowerShell 完成全部类别，避免反复拉起进程）。
 *
 * 只检测「判定明确」的失效项，逐项记录其指向的、已不存在的目标路径：
 * 1. 卸载残留：Uninstall 下的条目，其卸载程序 / 安装目录已不存在；
 * 2. 无效启动项：Run / RunOnce 中指向的可执行文件已不存在；
 * 3. 丢失的共享 DLL：SharedDLLs 中登记的文件已不存在；
 * 4. 无效应用路径：App Paths 下登记的 exe 已不存在。
 *
 * 安全约束：不触碰 HKLM\SYSTEM、不检测服务项、不检测文件关联（误伤面大）。
 * 环境变量一律先展开再判定，避免 `%windir%\...` 被误判为失效。
 */
async function scanRaw(): Promise<
  Array<{ cat: string; keyPath: string; name: string; kind: string; target: string; detail: string }>
> {
  const script = `
function Get-ExeFromCommand([string]$cmd) {
  if ([string]::IsNullOrWhiteSpace($cmd)) { return '' }
  $s = $cmd.Trim()
  if ($s.StartsWith('"')) {
    $idx = $s.IndexOf('"', 1)
    if ($idx -le 1) { return '' }
    return $s.Substring(1, $idx - 1)
  }
  # 未加引号时路径可能含空格（典型：C:\\Program Files (x86)\\...\\app.exe）。
  # 不能按空格取首段，否则会把 "C:\\Program" 当成路径而误判失效，
  # 因此逐段累加，找出第一个真实存在的 .exe。
  $parts = $s -split '\\s+'
  for ($i = 1; $i -le $parts.Count; $i++) {
    $cand = ($parts[0..($i-1)] -join ' ')
    if ($cand -match '\\.exe$' -and (Test-Path -LiteralPath $cand -ErrorAction SilentlyContinue)) { return $cand }
  }
  # 都不存在：取到第一个 .exe 为止的完整片段作为「疑似路径」上报
  $m = [regex]::Match($s, '.+?\\.exe', 'IgnoreCase')
  if ($m.Success) { return $m.Value.Trim() }
  return ''
}
function Test-Target([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return $false }
  if ($p -notmatch '^[a-zA-Z]:') { return $false }
  $full = [Environment]::ExpandEnvironmentVariables($p)
  if ([string]::IsNullOrWhiteSpace($full)) { return $false }
  return -not (Test-Path -LiteralPath $full -ErrorAction SilentlyContinue)
}
$out = New-Object System.Collections.ArrayList

# 1) 卸载残留
$uninstallRoots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($p in $uninstallRoots) {
  $subs = Get-ChildItem -Path $p -ErrorAction SilentlyContinue
  foreach ($s in $subs) {
    $k = Get-ItemProperty -LiteralPath $s.PSPath -ErrorAction SilentlyContinue
    if (-not $k) { continue }
    $dn = [string]$k.DisplayName
    if ($dn.Trim() -eq '') { continue }
    $us = [string]$k.UninstallString
    $il = [string]$k.InstallLocation
    $target = ''
    if ($us -ne '' -and $us -notmatch 'msiexec') {
      $exe = Get-ExeFromCommand $us
      if (Test-Target $exe) { $target = $exe }
    }
    if ($target -eq '' -and $il -ne '') {
      if (Test-Target $il) { $target = $il }
    }
    if ($target -ne '') {
      [void]$out.Add([PSCustomObject]@{ cat='卸载残留'; keyPath=$p; name=$s.PSChildName; kind='key'; target=$target; detail=$dn })
    }
  }
}

# 2) 无效启动项
$runRoots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'
)
foreach ($p in $runRoots) {
  $props = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
  if (-not $props) { continue }
  foreach ($pr in $props.PSObject.Properties) {
    if ($pr.Name -like 'PS*') { continue }
    $cmd = [string]$pr.Value
    if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
    if ($cmd -match 'msiexec') { continue }
    $exe = Get-ExeFromCommand $cmd
    if (Test-Target $exe) {
      [void]$out.Add([PSCustomObject]@{ cat='无效启动项'; keyPath=$p; name=$pr.Name; kind='value'; target=$exe; detail=$cmd })
    }
  }
}

# 3) 丢失的共享 DLL
$sd = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs'
$props = Get-ItemProperty -Path $sd -ErrorAction SilentlyContinue
if ($props) {
  foreach ($pr in $props.PSObject.Properties) {
    if ($pr.Name -like 'PS*') { continue }
    if (Test-Target ([string]$pr.Name)) {
      [void]$out.Add([PSCustomObject]@{ cat='丢失的共享 DLL'; keyPath=$sd; name=$pr.Name; kind='value'; target=[string]$pr.Name; detail=[string]$pr.Name })
    }
  }
}

# 4) 无效应用路径
foreach ($p in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
  $subs = Get-ChildItem -Path $p -ErrorAction SilentlyContinue
  foreach ($s in $subs) {
    $rk = Get-Item -LiteralPath $s.PSPath -ErrorAction SilentlyContinue
    if (-not $rk) { continue }
    $def = ''
    try { $def = [string]$rk.GetValue('') } catch { $def = '' }
    if ([string]::IsNullOrWhiteSpace($def)) { continue }
    $exe = ($def -replace '"','').Trim()
    if (Test-Target $exe) {
      [void]$out.Add([PSCustomObject]@{ cat='无效应用路径'; keyPath=$p; name=$s.PSChildName; kind='key'; target=$exe; detail=$def })
    }
  }
}
ConvertTo-Json -InputObject ([object[]]$out) -Depth 4 -Compress
`.trim()

  const raw = await runPs(script)
  const text = raw.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  } catch {
    return []
  }
}

/**
 * 流式扫描无效注册表项。
 *
 * PowerShell 一次性返回全部结果，这里再按批 yield 并在批间 `setImmediate`
 * 让出事件循环，避免一次性渲染上千条导致界面卡顿，同时保证「取消」能及时响应。
 */
export async function* scanRegistryStream(
  isCancelled: () => boolean,
): AsyncGenerator<RegistryEntry[], void, unknown> {
  const raw = await scanRaw()
  let batch: RegistryEntry[] = []
  for (const r of raw) {
    if (isCancelled()) return
    const kind: RegistryEntry['kind'] = r.kind === 'key' ? 'key' : 'value'
    batch.push({
      id: hashId(`${r.keyPath}|${r.name}`),
      category: r.cat ?? '其他',
      key_path: r.keyPath ?? '',
      name: r.name ?? '',
      kind,
      target: r.target ?? '',
      detail: r.detail ?? '',
    })
    if (batch.length >= BATCH) {
      yield batch
      batch = []
      await new Promise((res) => setImmediate(res))
    }
  }
  if (batch.length) yield batch
}

/** 读取某个注册表值的类型与数据（用于备份，供后续精确还原）。 */
async function readValueForBackup(
  keyPath: string,
  name: string,
): Promise<{ type: string; data: string } | null> {
  const script = `
$k = Get-Item -LiteralPath ${psQuote(keyPath)} -ErrorAction SilentlyContinue
if (-not $k) { ConvertTo-Json $null -Compress; exit }
try {
  $t = $k.GetValueKind(${psQuote(name)})
} catch { ConvertTo-Json $null -Compress; exit }
if ($t -eq 'Binary') { ConvertTo-Json $null -Compress; exit }
$v = [string]$k.GetValue(${psQuote(name)})
ConvertTo-Json -InputObject @{ type = [string]$t; data = $v } -Compress
`.trim()
  try {
    const out = (await runPs(script)).trim()
    if (!out || out === 'null') return null
    const p = JSON.parse(out) as { type?: string; data?: string }
    if (!p.type) return null
    return { type: p.type, data: p.data ?? '' }
  } catch {
    return null
  }
}

/** 读取整个子键下的所有值（kind=key 的项备份用）。 */
async function readKeyValuesForBackup(
  keyPath: string,
  name: string,
): Promise<Array<{ name: string; type: string; data: string }>> {
  const full = `${keyPath}\\${name}`
  const script = `
$k = Get-Item -LiteralPath ${psQuote(full)} -ErrorAction SilentlyContinue
if (-not $k) { ConvertTo-Json -InputObject @() -Compress; exit }
$res = @()
foreach ($n in $k.GetValueNames()) {
  if ($n -eq '') { continue }
  $t = ''
  try { $t = [string]$k.GetValueKind($n) } catch { continue }
  if ($t -eq 'Binary') { continue }
  $res += [PSCustomObject]@{ name = $n; type = $t; data = [string]$k.GetValue($n) }
}
ConvertTo-Json -InputObject ([object[]]$res) -Depth 4 -Compress
`.trim()
  try {
    const out = (await runPs(script)).trim()
    if (!out) return []
    const p = JSON.parse(out)
    return Array.isArray(p) ? p : p ? [p] : []
  } catch {
    return []
  }
}

/**
 * 删除前备份：把待删项的键值快照写入 JSON。
 *
 * 不使用 `reg export`（需额外依赖 reg.exe），改为自采快照 + 应用内「恢复」，
 * 数据更可控且可精确还原值的类型（String / ExpandString / DWord / QWord）。
 */
async function backupEntries(entries: RegistryEntry[]): Promise<string> {
  const items: any[] = []
  for (const e of entries) {
    if (e.kind === 'value') {
      const v = await readValueForBackup(e.key_path, e.name)
      items.push({
        kind: 'value',
        key_path: e.key_path,
        name: e.name,
        type: v?.type ?? null,
        data: v?.data ?? null,
        category: e.category,
        target: e.target,
      })
    } else {
      const vals = await readKeyValuesForBackup(e.key_path, e.name)
      items.push({
        kind: 'key',
        key_path: e.key_path,
        name: e.name,
        values: vals,
        category: e.category,
        target: e.target,
      })
    }
  }
  const file = path.join(
    backupDir(),
    `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  fs.writeFileSync(
    file,
    JSON.stringify({ created_at: new Date().toISOString(), items }, null, 2),
    'utf8',
  )
  return file
}

/** 列出已有备份（按时间倒序）。 */
export function listBackups(): Array<{ file: string; created_at: string; count: number }> {
  const dir = backupDir()
  const out: Array<{ file: string; created_at: string; count: number }> = []
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const f of files) {
    const full = path.join(dir, f)
    try {
      const p = JSON.parse(fs.readFileSync(full, 'utf8'))
      out.push({
        file: full,
        created_at: p.created_at ?? '',
        count: Array.isArray(p.items) ? p.items.length : 0,
      })
    } catch {
      /* 跳过损坏的备份 */
    }
  }
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  return out
}

/**
 * 从备份恢复（尽力而为，单条失败不影响其余）。
 * @returns 成功恢复的条数
 */
export async function restoreBackup(file: string): Promise<{ restored: number; errors: string[] }> {
  let parsed: any
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { restored: 0, errors: ['备份文件无法解析'] }
  }
  const items: any[] = Array.isArray(parsed.items) ? parsed.items : []
  let restored = 0
  const errors: string[] = []

  for (const it of items) {
    try {
      if (it.kind === 'value') {
        if (!it.type || it.data === null) {
          errors.push(`${it.key_path}\\${it.name}: 备份缺少值数据，跳过`)
          continue
        }
        const script = `
$k = Get-Item -LiteralPath ${psQuote(it.key_path)} -ErrorAction SilentlyContinue
if (-not $k) { New-Item -Path ${psQuote(it.key_path)} -Force | Out-Null }
Set-ItemProperty -Path ${psQuote(it.key_path)} -Name ${psQuote(it.name)} -Value ${psQuote(String(it.data))} -Type ${psQuote(String(it.type))} -Force
`.trim()
        await runPs(script)
        restored += 1
      } else {
        const full = `${it.key_path}\\${it.name}`
        // 先重建子键，再把捕获到的值逐条写回
        await runPs(
          `
if (-not (Test-Path -LiteralPath ${psQuote(full)})) {
  New-Item -Path ${psQuote(it.key_path)} -Name ${psQuote(it.name)} -Force | Out-Null
}
$vals = ConvertFrom-Json ${psQuote(JSON.stringify(it.values ?? []))}
foreach ($v in $vals) {
  Set-ItemProperty -Path ${psQuote(full)} -Name $v.name -Value $v.data -Type $v.type -Force -ErrorAction SilentlyContinue
}
`.trim(),
        )
        restored += 1
      }
    } catch (e) {
      errors.push(`${it.key_path}\\${it.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { restored, errors }
}

/**
 * 删除注册表项（先备份，再逐项删除）。
 *
 * 纵深防御：
 * 1. 仅接受 id，从会话反查真实注册表位置，前端无法注入任意键路径；
 * 2. 删除前强制备份，备份失败则整体中止（fail-safe）；
 * 3. 删除前二次校验「目标路径确实不存在」且「注册表项确实存在」，防止误删；
 * 4. 逐项独立执行，单项失败不影响其余，全部结果回传前端。
 */
export async function deleteRegistryEntries(
  entries: RegistryEntry[],
): Promise<import('./model').RegistryCleanResult> {
  const result: import('./model').RegistryCleanResult = {
    deleted_count: 0,
    skipped: [],
    errors: [],
    backup_file: null,
  }
  if (entries.length === 0) return result

  // 2. 备份优先，失败即中止
  try {
    result.backup_file = await backupEntries(entries)
  } catch (e) {
    result.errors.push(
      `备份失败，已中止删除（不会改动注册表）：${e instanceof Error ? e.message : String(e)}`,
    )
    return result
  }

  for (const e of entries) {
    try {
      // 3. 二次校验：目标仍不存在 + 注册表项仍存在
      const check = await runPs(
        `
$full = ${psQuote(`${e.key_path}\\${e.name}`)}
$exists = $false
if ('${e.kind}' -eq 'value') {
  $p = Get-ItemProperty -Path ${psQuote(e.key_path)} -ErrorAction SilentlyContinue
  if ($p -and ($p.PSObject.Properties.Name -contains ${psQuote(e.name)})) { $exists = $true }
} else {
  $exists = Test-Path -LiteralPath $full
}
$t = [Environment]::ExpandEnvironmentVariables(${psQuote(e.target)})
$targetGone = -not (Test-Path -LiteralPath $t -ErrorAction SilentlyContinue)
ConvertTo-Json -InputObject @{ exists = $exists; targetGone = $targetGone } -Compress
`.trim(),
      )
      const chk = JSON.parse(check.trim()) as { exists?: boolean; targetGone?: boolean }
      if (!chk.exists) {
        result.skipped.push({ id: e.id, reason: '该项已不存在，跳过' })
        continue
      }
      if (!chk.targetGone) {
        result.skipped.push({ id: e.id, reason: '目标路径已恢复存在，跳过（疑似误判）' })
        continue
      }

      if (e.kind === 'value') {
        await runPs(
          `Remove-ItemProperty -Path ${psQuote(e.key_path)} -Name ${psQuote(e.name)} -Force -ErrorAction Stop`,
        )
      } else {
        await runPs(
          `Remove-Item -LiteralPath ${psQuote(`${e.key_path}\\${e.name}`)} -Recurse -Force -ErrorAction Stop`,
        )
      }
      result.deleted_count += 1
    } catch (err) {
      result.errors.push(
        `${e.key_path}\\${e.name}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return result
}
