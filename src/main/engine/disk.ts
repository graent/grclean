/**
 * 磁盘信息分析（design.md §3.16 / §9.6）。
 *
 * 通过 PowerShell 采集每块磁盘的容量占用、类型、Trim、文件系统等信息，
 * 用于健康评分的「磁盘健康」「文件系统与 4K 对齐」两项，以及未来的磁盘分析页。
 * 任何一项采集失败都降级为「未知」，不影响其他评分。
 */
import { runPs, parseJsonArray } from './ps'
import type { DiskType } from './score'

export interface DiskInfo {
  letter: string
  /** 卷标名称（用户给盘符起的名字，如「系统」「软件」），无则空串 */
  name: string
  fileSystem: string
  totalBytes: number
  freeBytes: number
  type: DiskType
  model: string
  /** SSD 是否开启 Trim；HDD / 未知为 null */
  trimEnabled: boolean | null
  /** 4K 是否对齐；无权限探测时为 null */
  aligned: boolean | null
  /** SMART 健康（基于 HealthStatus）；未知为 null */
  smartOk: boolean | null
  /** 健康标签：健康 / 关注 / 警告 / 危险 */
  healthy: '健康' | '关注' | '警告' | '危险'
  /** 是否为系统盘（%SystemDrive%，通常为 C:） */
  system: boolean
}

/** 物理磁盘（硬盘本体，可含多个卷 / 盘符）。 */
export interface PhysicalDiskInfo {
  /** 物理磁盘编号（Get-PhysicalDisk.DeviceId），用于查询 SMART */
  deviceId: number
  model: string
  type: DiskType
  serial: string
  /** 固件版本（Get-PhysicalDisk.FirmwareVersion） */
  firmware: string
  /** 总线类型：SATA / NVMe / USB 等 */
  busType: string
  /** 物理磁盘总容量（字节） */
  sizeBytes: number
  /** 该磁盘上挂载的盘符（卷），如 ['C','D'] */
  letters: string[]
  /** 各卷容量合计（字节） */
  totalBytes: number
  freeBytes: number
  smartOk: boolean | null
  healthy: DiskInfo['healthy']
  isSystem: boolean
}

function healthyLabel(d: Omit<DiskInfo, 'healthy'>): DiskInfo['healthy'] {
  if (d.smartOk === false) return '危险'
  if (d.type === 'SSD' && d.trimEnabled === false) return '关注'
  if (d.fileSystem && d.fileSystem !== 'NTFS') return '关注'
  if (d.smartOk === null && d.type === 'Unknown') return '关注'
  return '健康'
}

/** 采集系统盘（%SystemDrive%，通常 C:）信息。 */
export async function getSystemDiskInfo(): Promise<DiskInfo | null> {
  const sysLetter = (await runPs('$env:SystemDrive')).trim().replace(':', '').toUpperCase() || 'C'
  return getDiskInfoByLetter(sysLetter)
}

/** 采集指定盘符的磁盘信息。 */
export async function getDiskInfoByLetter(letter: string): Promise<DiskInfo | null> {
  const L = letter.replace(':', '').toUpperCase()
  const sysLetter = (process.env.SystemDrive || 'C:').replace(':', '').toUpperCase()
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$letter = '${L}'
$vol = Get-Volume -DriveLetter $letter -ErrorAction SilentlyContinue
$part = ($vol | Get-Partition -ErrorAction SilentlyContinue | Select-Object -First 1)
$disk = ($part | Get-Disk -ErrorAction SilentlyContinue)
$data = [ordered]@{
  letter = $letter
  name = if ($vol) { $vol.FileSystemLabel } else { '' }
  fileSystem = if ($vol) { $vol.FileSystem } else { '' }
  totalBytes = if ($vol) { [int64]$vol.Size } else { 0 }
  freeBytes = if ($vol) { [int64]$vol.SizeRemaining } else { 0 }
  type = if ($disk) { $disk.MediaType } else { 'Unknown' }
  model = if ($disk) { $disk.Model } else { '' }
  trimEnabled = $null
  aligned = $null
  smartOk = $null
}
if ($disk) { $data.smartOk = ($disk.HealthStatus -eq 'Healthy') }
try {
  $t = (fsutil behavior query DisableDeleteNotify) -replace '[^0-9]' , ''
  if ($t -ne '') { $data.trimEnabled = ($t -eq '0') }
} catch {}
ConvertTo-Json -Compress $data
`
  const arr = parseJsonArray(await runPs(ps))
  const d = arr[0]
  if (!d) return null
  const typeMap: Record<string, DiskType> = { SSD: 'SSD', HDD: 'HDD' }
  const base: Omit<DiskInfo, 'healthy'> = {
    letter: d.letter,
    name: d.name || '',
    fileSystem: d.fileSystem || '',
    totalBytes: Number(d.totalBytes) || 0,
    freeBytes: Number(d.freeBytes) || 0,
    type: typeMap[d.type] || 'Unknown',
    model: d.model || '',
    trimEnabled: d.trimEnabled === null ? null : !!d.trimEnabled,
    aligned: d.aligned === null ? null : !!d.aligned,
    smartOk: d.smartOk === null ? null : !!d.smartOk,
    system: d.letter.toUpperCase() === sysLetter,
  }
  return { ...base, healthy: healthyLabel(base) }
}

/** SMART 概览中的一行（界面表格：项目 / 数值 / 状态色）。 */
export interface SmartRow {
  label: string
  value: string
  /** true=正常（绿） / false=异常（红） / null=未知（灰） */
  ok: boolean | null
}

/**
 * 采集单盘 SMART 概览：Trim 状态、剩余寿命、重映射扇区、温度、通电时长。
 *
 * 数据来源：`Get-StorageReliabilityCounter`（温度/通电时长/磨损）、
 * `MSStorageDriver_FailurePredictStatus`（故障预警，代表重映射扇区等风险）、
 * `fsutil behavior query DisableDeleteNotify`（Trim）。
 * 任一项采集失败降级为「未知」，不影响其他项（对应设计「失败时降级为未知」）。
 */
export async function getSmartOverview(deviceId: number): Promise<SmartRow[]> {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$id=[int]${deviceId}
$admin=(New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$pd=Get-PhysicalDisk -DeviceId $id -ErrorAction SilentlyContinue
$disk=($pd | Get-Disk -ErrorAction SilentlyContinue | Select-Object -First 1)
$phys=$pd | Select-Object -First 1

# 磁盘健康状态（Get-Disk.HealthStatus，普通权限即可获取，最可靠）
$health = if($disk){ [string]$disk.HealthStatus } else { $null }

# Trim（fsutil，普通权限；多行结果取末位有效值并布尔化）
$trim=$null
try {
  $raw = (fsutil behavior query DisableDeleteNotify)
  $nums = ($raw | ForEach-Object { ($_ -replace '[^0-9]','') } | Where-Object { $_ -ne '' })
  if($nums.Count -gt 0){ $trim = ($nums[-1] -eq '0') }
} catch {}

# 存储可靠性计数器（温度/通电时长/磨损/读取错误）：独立 try，
# 失败（如未提权）只影响本组，不再连累「故障预测」等其他 SMART 项。
$relOk=$true; $rel=$null
try {
  if($phys){ $rel = ($phys | Get-StorageReliabilityCounter -ErrorAction Stop) }
} catch { $relOk=$false }

# 故障预测（重映射扇区风险）：root\\wmi，部分磁盘/控制器即使管理员也未必暴露，独立 try。
$predOk=$true; $predict=$null
try {
  $p = Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop | Select-Object -First 1
  if($p){ $predict = [bool]$p.PredictFailure }
} catch { $predOk=$false }

ConvertTo-Json -Compress ([ordered]@{
  elevated   = [bool]$admin
  health     = $health
  trim       = $trim
  relOk      = $relOk
  predOk     = $predOk
  temperature= if($rel){ $rel.Temperature } else { $null }
  powerOnHours= if($rel){ $rel.PowerOnHours } else { $null }
  wear        = if($rel){ $rel.Wear } else { $null }
  readErrors  = if($rel){ $rel.ReadErrorsTotal } else { $null }
  predict     = $predict
})
`
  let d: any = {}
  try {
    const arr = parseJsonArray(await runPs(ps))
    d = arr[0] || {}
  } catch {
    d = {}
  }

  const rows: SmartRow[] = []
  // 是否提权：PowerShell 进程内检测 + Electron 进程标记，任一为真即视为已提权。
  // 用途：区分「未提权导致读不到」与「设备/控制器本身不支持」，
  // 避免即使以管理员身份运行也误报「需管理员权限」。
  const elevated: boolean = d.elevated === true || (process as any).isElevated === true
  // 计数器组不可用时的文案：未提权→需管理员权限；已提权但仍不可用→设备不支持
  const relUnavail = (): string => (elevated ? '不支持' : '需管理员权限')
  const predUnavail = (): string => (elevated ? '不支持' : '需管理员权限')

  // 磁盘健康（Get-Disk.HealthStatus，普通权限即可获取，最可靠）
  // 注意：Get-Disk.HealthStatus 返回的是**英文枚举**（Healthy / Warning / Unhealthy / Unknown），
  // 直接展示会出现「Healthy」这种未翻译的英文，故在此统一映射为中文，
  // 文案与磁盘卡片的 healthyLabel（健康 / 警告 / 危险）保持一致。
  const HEALTH_TEXT: Record<string, string> = {
    healthy: '健康',
    warning: '警告',
    unhealthy: '危险',
    degraded: '危险',
  }
  const healthKey = String(d.health ?? '').trim().toLowerCase()
  const healthBad = healthKey === 'warning' || healthKey === 'unhealthy' || healthKey === 'degraded'
  rows.push({
    label: '磁盘健康',
    value: HEALTH_TEXT[healthKey] ?? '未知',
    ok: healthKey === 'healthy' ? true : healthBad ? false : null,
  })

  // Trim 状态（仅 SSD 有意义；普通权限可获取）
  const trim = d.trim === null || d.trim === undefined ? null : !!d.trim
  rows.push({
    label: 'Trim 状态',
    value: trim === null ? '未知' : trim ? '已启用' : '未启用',
    ok: trim === null ? null : trim,
  })

  // 剩余寿命（磨损百分比取反；HDD 通常无此项，Wear 为 null/0）
  const wear = Number(d.wear)
  if (d.relOk !== false && Number.isFinite(wear) && wear >= 0 && wear <= 100) {
    const life = Math.max(0, Math.min(100, Math.round(100 - wear)))
    rows.push({ label: '剩余寿命', value: `${life}%`, ok: life >= 80 })
  } else if (d.relOk !== false) {
    rows.push({ label: '剩余寿命', value: '未知', ok: null })
  } else {
    rows.push({ label: '剩余寿命', value: relUnavail(), ok: null })
  }

  // 重映射 / 故障预警（root\wmi 故障预测，独立于可靠性计数器）
  const predict = d.predict === null || d.predict === undefined ? null : !!d.predict
  const readErrors = Number(d.readErrors)
  if (d.predOk !== false && predict === true) {
    rows.push({ label: '重映射扇区', value: '存在故障预警', ok: false })
  } else if (d.predOk !== false && predict === false && Number.isFinite(readErrors)) {
    rows.push({
      label: '重映射扇区',
      value: `0（读取错误 ${readErrors}）`,
      ok: readErrors === 0,
    })
  } else if (d.predOk !== false) {
    rows.push({ label: '重映射扇区', value: '未知', ok: null })
  } else {
    rows.push({ label: '重映射扇区', value: predUnavail(), ok: null })
  }

  // 温度（存储可靠性计数器以开尔文返回，需换算为摄氏）
  const temp = Number(d.temperature)
  if (d.relOk !== false && Number.isFinite(temp) && temp > 0) {
    const c = Math.round(temp - 273.15)
    rows.push({ label: '温度', value: `${c}℃`, ok: c <= 55 })
  } else if (d.relOk !== false) {
    rows.push({ label: '温度', value: '未知', ok: null })
  } else {
    rows.push({ label: '温度', value: relUnavail(), ok: null })
  }

  // 通电时长
  const hrs = Number(d.powerOnHours)
  if (d.relOk !== false && Number.isFinite(hrs) && hrs > 0) {
    const years = (hrs / 8760).toFixed(1)
    rows.push({
      label: '通电时长',
      value: `${hrs.toLocaleString('en-US')} 小时（约 ${years} 年）`,
      ok: null,
    })
  } else if (d.relOk !== false) {
    rows.push({ label: '通电时长', value: '未知', ok: null })
  } else {
    rows.push({ label: '通电时长', value: relUnavail(), ok: null })
  }

  return rows
}

/**
 * 采集物理磁盘清单（硬盘本体）：聚合每块磁盘上的所有卷（盘符）、容量、型号、
 * 总线类型与整体健康，供磁盘分析页的「物理磁盘切换」使用。
 */
export async function getPhysicalDisks(): Promise<PhysicalDiskInfo[]> {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$sys=($env:SystemDrive -replace ':','').ToUpper()
$pds=Get-PhysicalDisk
$out=@()
foreach($pd in $pds){
  $disks=$pd | Get-Disk -ErrorAction SilentlyContinue
  $letters=@(); $total=[int64]0; $free=[int64]0; $health=$null
  foreach($dk in $disks){
    if($health -eq $null){ $health=[string]$dk.HealthStatus }
    $parts=$dk | Get-Partition -ErrorAction SilentlyContinue
    foreach($pt in $parts){
      $vol=$pt | Get-Volume -ErrorAction SilentlyContinue
      if($vol -and $vol.DriveLetter){
        $l=[string]$vol.DriveLetter
        if($letters -notcontains $l){ $letters+=$l }
        $total+=[int64]$vol.Size
        $free+=[int64]$vol.SizeRemaining
      }
    }
  }
  $out+= [ordered]@{
    deviceId=[int]$pd.DeviceId
    model=if($pd.FriendlyName){$pd.FriendlyName}else{$pd.Model}
    mediaType=$pd.MediaType
    serial=$pd.SerialNumber
    firmware=$pd.FirmwareVersion
    busType=$pd.BusType
    sizeBytes=[int64]$pd.Size
    letters=@($letters | Sort-Object)
    totalBytes=$total
    freeBytes=$free
    health=$health
    isSystem=($letters -contains $sys)
  }
}
ConvertTo-Json -Compress $out
`
  const arr = parseJsonArray(await runPs(ps))
  const typeMap: Record<string, DiskType> = { SSD: 'SSD', HDD: 'HDD' }
  return arr.map((d: any) => {
    const smartOk =
      d.health === null || d.health === undefined
        ? null
        : String(d.health).trim().toLowerCase() === 'healthy'
    const base: Omit<DiskInfo, 'healthy'> = {
      letter: '',
      name: '',
      fileSystem: '',
      totalBytes: Number(d.totalBytes) || 0,
      freeBytes: Number(d.freeBytes) || 0,
      type: typeMap[d.mediaType] || 'Unknown',
      model: d.model || '',
      trimEnabled: null,
      aligned: null,
      smartOk,
      system: !!d.isSystem,
    }
    return {
      deviceId: Number(d.deviceId) || 0,
      model: d.model || '未知型号',
      type: typeMap[d.mediaType] || 'Unknown',
      serial: d.serial || '',
      firmware: d.firmware || '',
      busType: d.busType || '未知',
      sizeBytes: Number(d.sizeBytes) || 0,
      letters: Array.isArray(d.letters)
        ? d.letters.map((x: any) => String(x).toUpperCase())
        : [],
      totalBytes: Number(d.totalBytes) || 0,
      freeBytes: Number(d.freeBytes) || 0,
      smartOk,
      healthy: healthyLabel(base),
      isSystem: !!d.isSystem,
    }
  })
}

/** 根据 SMART 行判断是否需要管理员权限（未提权）。 */
export function smartNeedsAdmin(rows: SmartRow[]): boolean {
  return rows.some((r) => r.value === '需管理员权限')
}

/** 根据 SMART 行判断是否为设备不支持。 */
export function smartUnsupported(rows: SmartRow[]): boolean {
  return rows.some((r) => r.value === '不支持')
}

/** 采集所有本地卷的磁盘信息（供磁盘分析页使用）。 */
export async function getAllDiskInfo(): Promise<DiskInfo[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
foreach ($vol in (Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter })) {
  $letter = $vol.DriveLetter
  $part = ($vol | Get-Partition -ErrorAction SilentlyContinue | Select-Object -First 1)
  $disk = ($part | Get-Disk -ErrorAction SilentlyContinue)
  $trim = $null; $smart = $null
  if ($disk) { $smart = ($disk.HealthStatus -eq 'Healthy') }
  try { $t = (fsutil behavior query DisableDeleteNotify) -replace '[^0-9]',''; if ($t -ne '') { $trim = ($t -eq '0') } } catch {}
  $out += [ordered]@{
    letter = $letter
    name = if ($vol) { $vol.FileSystemLabel } else { '' }
    fileSystem = if ($vol) { $vol.FileSystem } else { '' }
    totalBytes = if ($vol) { [int64]$vol.Size } else { 0 }
    freeBytes = if ($vol) { [int64]$vol.SizeRemaining } else { 0 }
    type = if ($disk) { $disk.MediaType } else { 'Unknown' }
    model = if ($disk) { $disk.Model } else { '' }
    trimEnabled = $trim
    aligned = $null
    smartOk = $smart
  }
}
ConvertTo-Json -Compress $out
`
  const arr = parseJsonArray(await runPs(ps))
  const typeMap: Record<string, DiskType> = { SSD: 'SSD', HDD: 'HDD' }
  const sysLetter = (process.env.SystemDrive || 'C:').replace(':', '').toUpperCase()
  return arr.map((d: any) => {
    const base: Omit<DiskInfo, 'healthy'> = {
      letter: d.letter,
      name: d.name || '',
      fileSystem: d.fileSystem || '',
      totalBytes: Number(d.totalBytes) || 0,
      freeBytes: Number(d.freeBytes) || 0,
      type: typeMap[d.type] || 'Unknown',
      model: d.model || '',
      trimEnabled: d.trimEnabled === null ? null : !!d.trimEnabled,
      aligned: d.aligned === null ? null : !!d.aligned,
      smartOk: d.smartOk === null ? null : !!d.smartOk,
      system: d.letter.toUpperCase() === sysLetter,
    }
    return { ...base, healthy: healthyLabel(base) }
  })
}
