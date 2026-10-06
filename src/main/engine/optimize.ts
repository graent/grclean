/**
 * 磁盘优化与「更多优化」项（design.md §5.1 / §5.3）。
 *
 * 设计原则：**默认保守、需确认**。本模块只做两件事——
 * 1. **检测**：把 Trim / 碎片 / 存储感知 / CompactOS / 可延迟服务 / WSL·Docker 的现状如实呈现；
 * 2. **用户主动触发的变更**：每一项变更都由界面显式点击后才执行，且会回传真实结果。
 *
 * 绝不在扫描或启动时自动修改任何系统设置。
 * 所有 PowerShell 采集失败都降级为 `unknown`，不影响其他项展示。
 */
import { runPs, parseJsonArray } from './ps'

/** 单项状态：good=已优化 / warn=可改进 / bad=异常 / unknown=采集失败 */
export type OptStatus = 'good' | 'warn' | 'bad' | 'unknown'

/** 一个优化项（界面按卡片展示，带状态标签与操作按钮）。 */
export interface OptimizeOption {
  id: 'trim' | 'defrag' | 'storagesense' | 'compactos'
  title: string
  desc: string
  status: OptStatus
  /** 当前状态的人类可读描述 */
  value: string
  /** 建议动作文案；空表示当前无需操作 */
  advice: string
  /** 是否需要管理员权限 */
  needAdmin: boolean
}

/** 一次优化动作的执行结果。 */
export interface OptimizeResult {
  ok: boolean
  message: string
}

/** 可延迟启动的第三方服务（启动加速用）。 */
export interface DelayableService {
  name: string
  displayName: string
  /** 当前是否已设为延迟启动 */
  delayed: boolean
  /** 第三方（路径不在 Windows 目录下）自动启动服务才建议延迟 */
  thirdParty: boolean
}

/** WSL / Docker 占用检测结果（只检测并给出迁移建议，不自动迁移）。 */
export interface VhdInfo {
  id: 'wsl' | 'docker'
  title: string
  /** 当前位置描述 */
  location: string
  /** 体积（字节）；未知为 0 */
  bytes: number
  /** 是否存在 */
  exists: boolean
  /** 迁移建议 */
  advice: string
}

const MEDIA_UNKNOWN = 'Unknown'

/** 采集磁盘优化四项的状态。 */
export async function getOptimizeStatus(letter: string): Promise<OptimizeOption[]> {
  const L = letter.replace(':', '').toUpperCase()
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$letter = '${L}'
$vol  = Get-Volume -DriveLetter $letter -ErrorAction SilentlyContinue
$part = ($vol | Get-Partition -ErrorAction SilentlyContinue | Select-Object -First 1)
$disk = ($part | Get-Disk -ErrorAction SilentlyContinue)
$media = if ($disk) { $disk.MediaType } else { '${MEDIA_UNKNOWN}' }
$trim = $null
try {
  $t = (fsutil behavior query DisableDeleteNotify) -replace '[^0-9]',''
  if ($t -ne '') { $trim = ($t -eq '0') }
} catch {}
$ss = $null
try {
  $k = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StorageSense'
  $p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
  if ($p -and $p.PSObject.Properties.Name -contains '01') { $ss = ([int]$p.'01' -eq 1) }
} catch {}
$compact = $null
try {
  $c = ((compact.exe /CompactOS:query) -join ' ')
  if ($c -match 'not in the compact|未处于压缩|未压缩') { $compact = $false }
  elseif ($c -match 'in the compact|处于压缩') { $compact = $true }
} catch {}
ConvertTo-Json -Compress ([ordered]@{
  letter = $letter
  media  = $media
  trim   = $trim
  storageSense = $ss
  compact = $compact
})
`
  let d: any = {}
  try {
    d = parseJsonArray(await runPs(ps))[0] || {}
  } catch {
    d = {}
  }

  const media: string = d.media || MEDIA_UNKNOWN
  const isSSD = media.toUpperCase() === 'SSD'
  const isHDD = media.toUpperCase() === 'HDD'

  // ---- Trim（仅 SSD 有意义）----
  const trim: boolean | null =
    d.trim === null || d.trim === undefined ? null : !!d.trim
  let trimOpt: OptimizeOption
  if (!isSSD) {
    trimOpt = {
      id: 'trim',
      title: 'SSD Trim',
      desc: '让 SSD 及时回收已删除块，维持写入性能与寿命。',
      status: 'unknown',
      value: `当前盘为 ${media === MEDIA_UNKNOWN ? '未知介质' : media}，Trim 不适用`,
      advice: '',
      needAdmin: false,
    }
  } else if (trim === true) {
    trimOpt = {
      id: 'trim',
      title: 'SSD Trim',
      desc: '让 SSD 及时回收已删除块，维持写入性能与寿命。',
      status: 'good',
      value: '已启用（DisableDeleteNotify = 0）',
      advice: '',
      needAdmin: false,
    }
  } else if (trim === false) {
    trimOpt = {
      id: 'trim',
      title: 'SSD Trim',
      desc: '让 SSD 及时回收已删除块，维持写入性能与寿命。',
      status: 'warn',
      value: '未启用（DisableDeleteNotify = 1）',
      advice: '建议开启，操作瞬时生效且无需重启',
      needAdmin: true,
    }
  } else {
    trimOpt = {
      id: 'trim',
      title: 'SSD Trim',
      desc: '让 SSD 及时回收已删除块，维持写入性能与寿命。',
      status: 'unknown',
      value: '采集失败（可能无权限）',
      advice: '可尝试以管理员身份运行后重试',
      needAdmin: true,
    }
  }

  // ---- 碎片整理（仅 HDD）----
  const defragOpt: OptimizeOption = isHDD
    ? {
        id: 'defrag',
        title: '碎片整理',
        desc: '机械硬盘长期使用会产生碎片，整理可提升连续读写速度。',
        status: 'warn',
        value: 'HDD，可进行分析与整理',
        advice: '建议先「分析」，碎片率 > 10% 再整理',
        needAdmin: false,
      }
    : {
        id: 'defrag',
        title: '碎片整理',
        desc: '机械硬盘长期使用会产生碎片，整理可提升连续读写速度。',
        status: 'good',
        value: `当前盘为 ${isSSD ? 'SSD' : media === MEDIA_UNKNOWN ? '未知介质' : media}，不建议整理`,
        advice: '',
        needAdmin: false,
      }

  // ---- 存储感知 ----
  const ss: boolean | null =
    d.storageSense === null || d.storageSense === undefined ? null : !!d.storageSense
  const ssOpt: OptimizeOption =
    ss === true
      ? {
          id: 'storagesense',
          title: '存储感知',
          desc: 'Windows 自带的自动清理机制，可回收临时文件与过期回收站内容。',
          status: 'good',
          value: '已开启',
          advice: '',
          needAdmin: false,
        }
      : ss === false
        ? {
            id: 'storagesense',
            title: '存储感知',
            desc: 'Windows 自带的自动清理机制，可回收临时文件与过期回收站内容。',
            status: 'warn',
            value: '未开启',
            advice: '建议开启，让系统自动维护',
            needAdmin: false,
          }
        : {
            id: 'storagesense',
            title: '存储感知',
            desc: 'Windows 自带的自动清理机制，可回收临时文件与过期回收站内容。',
            status: 'unknown',
            value: '状态未知（不同 Windows 版本注册表位置有差异）',
            advice: '可打开系统设置页手动开启，或点「立即运行一次」',
            needAdmin: false,
          }

  // ---- 压缩系统文件 CompactOS ----
  const compact: boolean | null =
    d.compact === null || d.compact === undefined ? null : !!d.compact
  const compactOpt: OptimizeOption =
    compact === true
      ? {
          id: 'compactos',
          title: '压缩系统文件',
          desc: '用 NTFS 压缩系统文件，可省 1–2 GB；极少数场景有轻微性能代价。',
          status: 'good',
          value: '已处于压缩状态',
          advice: '',
          needAdmin: true,
        }
      : compact === false
        ? {
            id: 'compactos',
            title: '压缩系统文件',
            desc: '用 NTFS 压缩系统文件，可省 1–2 GB；极少数场景有轻微性能代价。',
            status: 'warn',
            value: '未压缩',
            advice: '磁盘紧张时可开启；SSD 上性能影响极小',
            needAdmin: true,
          }
        : {
            id: 'compactos',
            title: '压缩系统文件',
            desc: '用 NTFS 压缩系统文件，可省 1–2 GB；极少数场景有轻微性能代价。',
            status: 'unknown',
            value: '采集失败',
            advice: '',
            needAdmin: true,
          }

  return [trimOpt, defragOpt, ssOpt, compactOpt]
}

/** 开启 / 关闭 SSD Trim（需管理员）。 */
export async function setTrimEnabled(enable: boolean): Promise<OptimizeResult> {
  const v = enable ? '0' : '1'
  try {
    const out = await runPs(
      `$ErrorActionPreference='Stop'; (fsutil behavior set DisableDeleteNotify ${v}) -join ' '`,
    )
    return { ok: true, message: out.trim() || (enable ? '已开启 Trim' : '已关闭 Trim') }
  } catch (e) {
    return { ok: false, message: `执行失败（可能需要管理员）：${(e as Error).message}` }
  }
}

/** 碎片整理：analyze=true 只分析不整理。 */
export async function runDefrag(
  letter: string,
  analyze: boolean,
): Promise<OptimizeResult> {
  const L = letter.replace(':', '').toUpperCase()
  const arg = analyze ? `/A` : `/U /V`
  try {
    const out = await runPs(
      `$ErrorActionPreference='Stop'; (defrag ${L}: ${arg}) -join [char]10`,
    )
    return { ok: true, message: out.trim() || (analyze ? '分析完成' : '整理完成') }
  } catch (e) {
    return {
      ok: false,
      message: `执行失败：${(e as Error).message}${analyze ? '' : '（整理需管理员，且系统盘整理较慢）'}`,
    }
  }
}

/** 打开系统「存储感知」设置页（引导，不改注册表）。 */
export function openStorageSenseSettings(): Promise<OptimizeResult> {
  return Promise.resolve({ ok: true, message: 'STORAGE_SENSE_SETTINGS' })
}

/** 立即运行一次存储感知任务。 */
export async function runStorageSenseNow(): Promise<OptimizeResult> {
  try {
    await runPs(
      `$ErrorActionPreference='Stop'; Start-ScheduledTask -TaskPath '\\Microsoft\\Windows\\DiskFootprint\\' -TaskName 'StorageSense'`,
    )
    return { ok: true, message: '已触发存储感知任务（后台执行，稍后可见效果）' }
  } catch (e) {
    return { ok: false, message: `触发失败：${(e as Error).message}` }
  }
}

/** 设置 CompactOS 压缩状态（需管理员，耗时较长）。 */
export async function setCompactOs(enable: boolean): Promise<OptimizeResult> {
  const arg = enable ? ':always' : ':never'
  try {
    const out = await runPs(
      `$ErrorActionPreference='Stop'; (compact.exe /CompactOS${arg}) -join [char]10`,
    )
    return { ok: true, message: out.trim() || (enable ? '已开启压缩' : '已关闭压缩') }
  } catch (e) {
    return { ok: false, message: `执行失败（可能需要管理员）：${(e as Error).message}` }
  }
}

/**
 * 列出可延迟启动的服务（启动加速）。
 * 只挑「自动启动且路径不在 Windows 系统目录」的第三方服务，
 * 系统关键服务（白名单）一律排除，避免把系统组件改成延迟启动。
 */
export async function listDelayableServices(): Promise<DelayableService[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$deny = @('LSM','DPS','EventLog','EventSystem','Power','PlugPlay','ProfSvc','Schedule','SENS','Winmgmt','RpcSs','RpcEptMapper','DcomLaunch','BFE','mpssvc','WinDefend','WdNisSvc','SecurityHealthService','sppsvc','TrustedInstaller','wuauserv','BITS','CryptSvc','LanmanServer','LanmanWorkstation','Themes','AudioSrv','Audiosrv','FontCache','gpsvc','iphlpsvc','Dhcp','Dnscache','NlaSvc','nsi','netprofm','WlanSvc','Wcmsvc','UserManager','ShellHWDetection','SysMain','WSearch','UsoSvc','BrokerInfrastructure','SystemEventsBroker','SgrmBroker','CoreMessagingRegistrar','PimIndexMaintenanceSvc','OneSyncSvc','CDPSvc','WpnService','WpnUserService','tiledatamodelsvc','DiagTrack','DusmSvc','DoSvc','AppXSvc','ClipSvc','cbdhsvc','GraphicsPerfSvc','TimeBrokerSvc','TokenBroker','DeviceAssociationService','DevicesFlowUserSvc','PcaSvc','Spooler','RasMan','NcbService','NcdAutoSetup','WFDSConMgrSvc','FrameServer','ClickToRunSvc','OfficeSvc')
$out = @()
foreach ($s in (Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.StartMode -eq 'Auto' })) {
  if ($deny -contains $s.Name) { continue }
  $path = [string]$s.PathName
  $third = $true
  if ($path -match '\\\\Windows\\\\' -or $path -match '\\\\WinSxS\\\\' -or $path -eq '') { $third = $false }
  $delayed = $false
  $rk = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + $s.Name
  $p = Get-ItemProperty -Path $rk -ErrorAction SilentlyContinue
  if ($p -and $p.PSObject.Properties.Name -contains 'DelayedAutostart') { $delayed = ([int]$p.DelayedAutostart -eq 1) }
  $out += [ordered]@{
    name = $s.Name
    displayName = [string]$s.DisplayName
    delayed = $delayed
    thirdParty = $third
  }
}
ConvertTo-Json -Compress $out
`
  const arr = parseJsonArray(await runPs(ps))
  return arr
    .filter((s: any) => !!s.name)
    .map((s: any) => ({
      name: String(s.name),
      displayName: String(s.displayName || s.name),
      delayed: !!s.delayed,
      thirdParty: !!s.thirdParty,
    }))
    .sort((a, b) => {
      // 第三方优先，已延迟的排后面
      if (a.thirdParty !== b.thirdParty) return a.thirdParty ? -1 : 1
      if (a.delayed !== b.delayed) return a.delayed ? 1 : -1
      return a.name.localeCompare(b.name)
    })
}

/** 把服务设为延迟启动 / 取消延迟（需管理员）。 */
export async function setServiceDelayed(
  name: string,
  delayed: boolean,
): Promise<OptimizeResult> {
  const safe = String(name).replace(/[^A-Za-z0-9_.-]/g, '')
  if (!safe) return { ok: false, message: '服务名无效' }
  try {
    const out = await runPs(
      `$ErrorActionPreference='Stop'; (sc.exe config ${safe} start= ${delayed ? 'delayed-auto' : 'auto'}) -join [char]10`,
    )
    return { ok: true, message: out.trim() || (delayed ? '已设为延迟启动' : '已取消延迟启动') }
  } catch (e) {
    return { ok: false, message: `执行失败（可能需要管理员）：${(e as Error).message}` }
  }
}

/**
 * 检测 WSL / Docker 的磁盘占用（只检测 + 给建议，不自动迁移）。
 * WSL：读发行版列表与默认 ext4.vhdx 体积；Docker：读 settings.json 的 data-root 与 WSL 后端磁盘。
 */
export async function detectVhd(): Promise<VhdInfo[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()

# WSL
$wslDistros = @()
try { $wslDistros = @((wsl.exe -l -q) 2>$null | Where-Object { $_ -and $_.Trim() -ne '' }) } catch {}
$wslBytes = 0
$wslLoc = '未检测到 WSL 发行版'
$wslExist = $false
if ($wslDistros.Count -gt 0) {
  $wslExist = $true
  $wslLoc = ($wslDistros -join ', ')
  foreach ($vhd in @(Get-ChildItem -Path "$env:LOCALAPPDATA\\Packages" -Filter 'ext4.vhdx' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 10)) {
    $wslBytes += [int64]$vhd.Length
  }
}
$out += [ordered]@{ id='wsl'; location=$wslLoc; bytes=$wslBytes; exists=$wslExist }

# Docker
$dockerBytes = 0
$dockerLoc = '未检测到 Docker'
$dockerExist = $false
try {
  $sf = Join-Path $env:APPDATA 'Docker\\settings.json'
  if (Test-Path $sf) {
    $j = Get-Content $sf -Raw | ConvertFrom-Json
    $root = ''
    if ($j.PSObject.Properties.Name -contains 'DataFolder') { $root = $j.DataFolder }
    if ($root -and (Test-Path $root)) {
      $dockerExist = $true
      $dockerLoc = $root
      $dockerBytes = [int64]((Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum)
    }
  }
} catch {}
if (-not $dockerExist) {
  $dvhd = Join-Path $env:LOCALAPPDATA 'Docker\\wsl\\data\\ext4.vhdx'
  if (Test-Path $dvhd) {
    $dockerExist = $true
    $dockerLoc = $dvhd
    $dockerBytes = [int64](Get-Item $dvhd).Length
  }
}
$out += [ordered]@{ id='docker'; location=$dockerLoc; bytes=$dockerBytes; exists=$dockerExist }

ConvertTo-Json -Compress $out
`
  let arr: any[] = []
  try {
    arr = parseJsonArray(await runPs(ps))
  } catch {
    arr = []
  }
  const map: Record<string, { title: string; advice: string }> = {
    wsl: {
      title: 'WSL 虚拟磁盘',
      advice:
        'WSL 的 ext4.vhdx 默认在 C 盘且只增不减。可用 wsl --export/--import 迁移到其他盘（本工具不代劳，避免破坏开发环境）。',
    },
    docker: {
      title: 'Docker 数据目录',
      advice:
        '镜像与容器体积增长很快。可在 Docker Desktop → Settings → Resources 修改 Disk image location，或修改 daemon.json 的 data-root 到其他盘。',
    },
  }
  return arr.map((d: any) => {
    const id: 'wsl' | 'docker' = d.id === 'docker' ? 'docker' : 'wsl'
    const bytes = Number(d.bytes) || 0
    return {
      id,
      title: map[id].title,
      location: String(d.location || '未知'),
      bytes,
      exists: !!d.exists,
      advice: map[id].advice,
    }
  })
}
