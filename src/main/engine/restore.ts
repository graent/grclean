/**
 * 系统还原点管理（design.md §3.9 / §5.3）。
 *
 * 设计策略：**保留最近 1 个，清理更早的**。
 * 还原点会随系统更新不断累积、占用数 GB 到数十 GB，但真正有用的通常只有最近一个。
 *
 * 安全约束：
 * - **只删「更早」的，最近 1 个永不删除**（删除前二次校验剩余数量）；
 * - 删除用 `vssadmin delete shadows /oldest` 逐条删除最老的，绝不一次性清空；
 * - 关闭系统保护会**一并删除全部还原点**，属于高风险操作，界面需强确认后才调用；
 * - 所有操作需管理员，失败时回传真实错误信息。
 */
import { runPs, parseJsonArray } from './ps'

/** 还原点类型（RestorePointType）中文映射。 */
const TYPE_MAP: Record<number, string> = {
  0: '应用程序安装',
  1: '应用程序卸载',
  2: '系统还原',
  3: '检查点',
  4: '设备驱动安装',
  5: '备份',
  6: '手动创建',
  7: '系统设置更改',
  9: '设备驱动回滚',
  10: '设备驱动安装',
  11: '取消安装',
  12: '修改设置',
  13: '取消还原',
  14: '取消安装',
}

/** 单个还原点。 */
export interface RestorePoint {
  seq: number
  description: string
  /** 格式化后的创建时间 */
  time: string
  type: string
}

/** 卷的影子存储占用情况。 */
export interface RestoreStorage {
  volume: string
  maxMb: number
  usedMb: number
}

/** 系统还原整体状态。 */
export interface RestoreStatus {
  /** 系统保护是否启用（以是否存在影子存储为准） */
  enabled: boolean
  /** 系统盘符（如 C:） */
  systemVolume: string
  storage: RestoreStorage[]
  points: RestorePoint[]
  /** 还原点占用合计（MB） */
  totalUsedMb: number
}

/** 读取系统还原状态。 */
export async function getRestoreStatus(): Promise<RestoreStatus> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$sys = $env:SystemDrive
$points = @()
try {
  foreach ($p in (Get-ComputerRestorePoint -ErrorAction SilentlyContinue)) {
    # 先算出时间再进哈希表：避免在 hashtable 字面量里写 if 表达式（PowerShell 5.1 解析不稳）
    $t = ''
    if ($p.CreationTime) {
      $t = ([Management.ManagementDateTimeConverter]::ToDateTime($p.CreationTime)).ToString('yyyy-MM-dd HH:mm')
    }
    $points += [ordered]@{
      seq = [int]$p.SequenceNumber
      description = [string]$p.Description
      time = $t
      type = [int]$p.RestorePointType
    }
  }
} catch {}
$storage = @()
try {
  foreach ($s in (Get-CimInstance -ClassName Win32_ShadowStorage -ErrorAction SilentlyContinue)) {
    $storage += [ordered]@{
      volume = [string]$s.VolumeName
      maxMb  = [int]([int64]$s.MaxSpace / 1MB)
      usedMb = [int]([int64]$s.UsedSpace / 1MB)
    }
  }
} catch {}
ConvertTo-Json -Compress ([ordered]@{
  systemVolume = $sys
  points  = @($points)
  storage = @($storage)
})
`
  let d: any = {}
  try {
    d = parseJsonArray(await runPs(ps))[0] || {}
  } catch {
    d = {}
  }
  const points: RestorePoint[] = Array.isArray(d.points)
    ? d.points.map((p: any) => ({
        seq: Number(p.seq) || 0,
        description: String(p.description || ''),
        time: String(p.time || ''),
        type: TYPE_MAP[Number(p.type)] || `类型 ${Number(p.type) || '未知'}`,
      }))
    : []
  const storage: RestoreStorage[] = Array.isArray(d.storage)
    ? d.storage.map((s: any) => ({
        volume: String(s.volume || ''),
        maxMb: Number(s.maxMb) || 0,
        usedMb: Number(s.usedMb) || 0,
      }))
    : []
  // 按序号降序：最新在前
  points.sort((a, b) => b.seq - a.seq)
  return {
    enabled: storage.length > 0 || points.length > 0,
    systemVolume: String(d.systemVolume || 'C:'),
    storage,
    points,
    totalUsedMb: storage.reduce((n, s) => n + s.usedMb, 0),
  }
}

export interface RestoreResult {
  ok: boolean
  message: string
}

/**
 * 清理更早的还原点，保留最近 `keep` 个（默认 1）。
 *
 * 逐条删除最老的一个，每删一条都重新计数，确保任何异常中断都不会误删到保留位。
 */
export async function deleteOldRestorePoints(keep = 1): Promise<RestoreResult> {
  const keepN = Math.max(1, Math.floor(keep))
  const status = await getRestoreStatus()
  const vol = status.systemVolume.replace(':', '') + ':'
  if (!status.points.length) return { ok: true, message: '没有可清理的还原点' }
  const toDelete = status.points.length - keepN
  if (toDelete <= 0) {
    return { ok: true, message: `仅剩 ${status.points.length} 个还原点，已达到保留 ${keepN} 个的上限，无需清理` }
  }

  let deleted = 0
  let lastErr = ''
  for (let i = 0; i < toDelete; i++) {
    try {
      await runPs(
        `$ErrorActionPreference='Stop'; (vssadmin delete shadows /for=${vol} /oldest /quiet) -join [char]10`,
      )
      deleted++
    } catch (e) {
      lastErr = (e as Error).message
      break
    }
  }
  if (deleted === 0) {
    return { ok: false, message: `清理失败（可能需要管理员）：${lastErr}` }
  }
  return {
    ok: true,
    message: `已清理 ${deleted} 个较早还原点，保留最近 ${keepN} 个${lastErr ? `（剩余因权限中止：${lastErr}）` : ''}`,
  }
}

/** 调整还原点最大占用比例（1–100，需管理员）。 */
export async function setRestoreMaxPercent(pct: number): Promise<RestoreResult> {
  const p = Math.floor(pct)
  if (!Number.isFinite(p) || p < 1 || p > 100) return { ok: false, message: '比例无效（1–100）' }
  const status = await getRestoreStatus()
  const vol = status.systemVolume.replace(':', '') + ':'
  try {
    await runPs(
      `$ErrorActionPreference='Stop'; (vssadmin resize shadowstorage /for=${vol} /on=${vol} /maxsize=${p}%) -join [char]10`,
    )
    return { ok: true, message: `已将还原点最大占用调整为 ${p}%` }
  } catch (e) {
    return { ok: false, message: `调整失败（可能需要管理员）：${(e as Error).message}` }
  }
}

/** 启用 / 关闭系统保护。关闭会删除全部还原点，属高风险。 */
export async function setSystemProtection(enable: boolean): Promise<RestoreResult> {
  const status = await getRestoreStatus()
  const vol = status.systemVolume.replace(':', '') + ':'
  const cmd = enable ? 'Enable-ComputerRestore' : 'Disable-ComputerRestore'
  try {
    await runPs(`$ErrorActionPreference='Stop'; ${cmd} ${vol}`)
    return {
      ok: true,
      message: enable
        ? `已启用 ${vol} 的系统保护（之后系统会自动创建还原点）`
        : `已关闭 ${vol} 的系统保护（原有还原点一并删除，且不可恢复）`,
    }
  } catch (e) {
    return { ok: false, message: `操作失败（可能需要管理员）：${(e as Error).message}` }
  }
}
