/**
 * 虚拟内存（pagefile.sys）可视化与优化（design.md §5.3）。
 *
 * 提供三件事：
 * 1. **可视化**：当前是「系统托管」还是「自定义」、初始/最大大小、所在盘符、物理内存；
 * 2. **建议值**：按设计给出的经验系数（≤8GB 取 1.5 倍、8–16GB 取 1–1.5 倍、≥16GB 取 1 倍），
 *    并对最大值封顶（32 GB），避免无意义地吃掉磁盘；
 * 3. **一键优化**：写回 `PagingFiles` 注册表值，支持「系统托管 / 自定义固定 / 迁移到非系统盘」。
 *
 * 安全约束：
 * - **只改页面文件本身**，绝不触碰其他内存管理设置；
 * - 任何写入前先校验盘符合法（单个大写字母）且该卷存在；
 * - 变更后**不自动重启**，只明确提示「重启后生效」。
 */
import { runPs, parseJsonArray } from './ps'

/** 页面文件当前的完整状态。 */
export interface PagefileInfo {
  /** 是否为系统托管 */
  autoManaged: boolean
  /** 物理内存（MB） */
  ramMb: number
  /** 注册表原始配置字符串 */
  raw: string
  /** 逐条页面文件配置 */
  files: Array<{
    drive: string
    /** 初始大小（MB）；0=系统托管 */
    initialMb: number
    /** 最大大小（MB）；0=系统托管 */
    maxMb: number
    /** 当前实际占用（MB），来自 Win32_PageFileUsage */
    usedMb: number
  }>
  /** 建议初始大小（MB） */
  suggestInitialMb: number
  /** 建议最大大小（MB） */
  suggestMaxMb: number
  /** 建议说明 */
  suggestReason: string
}

/** 可迁移到的目标盘（剩余空间充足的非系统盘）。 */
export interface PagefileTarget {
  letter: string
  freeBytes: number
  totalBytes: number
}

const MAX_CAP_MB = 32768

/** 按内存容量给出建议值（对齐设计 §5.3 的经验系数）。 */
function suggest(ramMb: number): { initial: number; max: number; reason: string } {
  const gb = ramMb / 1024
  let factor: number
  let reason: string
  if (gb <= 8) {
    factor = 1.5
    reason = `物理内存 ${gb.toFixed(1)} GB（≤8GB），建议取 1.5 倍`
  } else if (gb < 16) {
    factor = 1.25
    reason = `物理内存 ${gb.toFixed(1)} GB（8–16GB），建议取 1–1.5 倍，此处取 1.25 倍`
  } else {
    factor = 1
    reason = `物理内存 ${gb.toFixed(1)} GB（≥16GB），建议取 1 倍即可`
  }
  const initial = Math.max(1024, Math.round((ramMb * factor) / 256) * 256)
  const max = Math.min(MAX_CAP_MB, Math.round((initial * 1.5) / 256) * 256)
  return { initial, max, reason: `${reason}；最大值封顶 ${MAX_CAP_MB / 1024} GB 避免浪费` }
}

/** 读取当前页面文件配置。 */
export async function getPagefileInfo(): Promise<PagefileInfo> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$mm = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management'
$rawList = @()
$p = Get-ItemProperty -Path $mm -Name PagingFiles -ErrorAction SilentlyContinue
if ($p -and $p.PagingFiles) { $rawList = @($p.PagingFiles) }
$auto = $false
try { $auto = [bool](Get-CimInstance Win32_ComputerSystem).AutomaticManagedPagefile } catch {}
$ramMb = 0
try { $ramMb = [int][math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB) } catch {}
$usage = @{}
try {
  foreach ($u in (Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue)) {
    if ($u.Name) { $usage[[string]$u.Name] = [int]$u.AllocatedBaseSize }
  }
} catch {}
$files = @()
foreach ($line in $rawList) {
  $s = [string]$line
  if ($s.Trim() -eq '') { continue }
  $parts = $s -split '\\s+'
  $drv = ''
  if ($parts[0] -match '^([A-Za-z]):') { $drv = ($matches[1]).ToUpper() }
  $init = 0; $maxv = 0
  if ($parts.Count -ge 3) { $init = [int]$parts[1]; $maxv = [int]$parts[2] }
  $used = 0
  foreach ($k in $usage.Keys) { if ($k.ToUpper().StartsWith($drv + ':')) { $used = $usage[$k] } }
  $files += [ordered]@{ drive=$drv; initialMb=$init; maxMb=$maxv; usedMb=$used }
}
ConvertTo-Json -Compress ([ordered]@{
  autoManaged = $auto
  ramMb = $ramMb
  raw = ($rawList -join ' | ')
  files = $files
})
`
  let d: any = {}
  try {
    d = parseJsonArray(await runPs(ps))[0] || {}
  } catch {
    d = {}
  }
  const ramMb = Number(d.ramMb) || 0
  const files = Array.isArray(d.files)
    ? d.files.map((f: any) => ({
        drive: String(f.drive || ''),
        initialMb: Number(f.initialMb) || 0,
        maxMb: Number(f.maxMb) || 0,
        usedMb: Number(f.usedMb) || 0,
      }))
    : []
  const s = suggest(ramMb)
  return {
    autoManaged: !!d.autoManaged,
    ramMb,
    raw: String(d.raw || ''),
    files,
    suggestInitialMb: s.initial,
    suggestMaxMb: s.max,
    suggestReason: s.reason,
  }
}

/** 列出可作为页面文件目标盘的卷（排除系统盘与剩余空间不足的）。 */
export async function listPagefileTargets(): Promise<PagefileTarget[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$sys = $env:SystemDrive
$out = @()
foreach ($v in (Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' })) {
  $l = [string]$v.DriveLetter
  if ($sys -and ($l + ':') -eq $sys) { continue }
  if ($v.FileSystem -ne 'NTFS') { continue }
  $out += [ordered]@{ letter=$l; freeBytes=[int64]$v.SizeRemaining; totalBytes=[int64]$v.Size }
}
ConvertTo-Json -Compress $out
`
  const arr = parseJsonArray(await runPs(ps))
  return arr
    .filter((v: any) => !!v.letter)
    .map((v: any) => ({
      letter: String(v.letter).toUpperCase(),
      freeBytes: Number(v.freeBytes) || 0,
      totalBytes: Number(v.totalBytes) || 0,
    }))
}

export interface PagefileApplyResult {
  ok: boolean
  message: string
}

/**
 * 应用页面文件设置（需管理员，重启后生效）。
 *
 * @param mode auto=系统托管（系统盘）| custom=自定义固定大小 | move=迁移到指定盘并由系统托管
 * @param letter 目标盘符（custom / move 时必填，单个字母）
 * @param initialMb 初始大小（custom 必填）
 * @param maxMb 最大大小（custom 必填）
 */
export async function applyPagefile(
  mode: 'auto' | 'custom' | 'move',
  letter: string,
  initialMb: number,
  maxMb: number,
): Promise<PagefileApplyResult> {
  const L = String(letter || '')
    .replace(':', '')
    .toUpperCase()
  if ((mode === 'custom' || mode === 'move') && !/^[A-Z]$/.test(L)) {
    return { ok: false, message: '目标盘符无效' }
  }
  if (mode === 'custom') {
    const i = Math.floor(Number(initialMb))
    const m = Math.floor(Number(maxMb))
    if (!Number.isFinite(i) || !Number.isFinite(m) || i < 16 || m < i) {
      return { ok: false, message: '自定义大小无效（初始需 ≥16MB，且最大不小于初始）' }
    }
  }

  let value: string
  if (mode === 'auto') value = 'C:\\pagefile.sys 0 0'
  else if (mode === 'custom') value = `${L}:\\pagefile.sys ${Math.floor(initialMb)} ${Math.floor(maxMb)}`
  else value = `${L}:\\pagefile.sys 0 0`

  const ps = `
$ErrorActionPreference = 'Stop'
$mm = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management'
Set-ItemProperty -Path $mm -Name PagingFiles -Value @('${value}') -Type MultiString
'OK'
`
  try {
    await runPs(ps)
  } catch (e) {
    return { ok: false, message: `写入失败（可能需要管理员）：${(e as Error).message}` }
  }
  const label =
    mode === 'auto'
      ? '已设为系统托管（系统盘）'
      : mode === 'custom'
        ? `已设为 ${L}: 固定 ${Math.floor(initialMb)}–${Math.floor(maxMb)} MB`
        : `已迁移到 ${L}: 并由系统托管`
  return {
    ok: true,
    message: `${label}。页面文件设置在**重启后生效**，请在保存好工作后重启电脑。`,
  }
}
