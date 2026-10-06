import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPs } from './ps'
import { grcleanDir } from './history'

/**
 * 系统属性信息（概览页「系统信息」卡片数据源）。
 * 数值字段保持原始类型，展示文案 / 单位由渲染层按当前语言组装。
 */
export interface SystemInfo {
  /** 操作系统显示名（含内核版本），如 "Windows 11 专业版 (10.0.26100)" */
  os: string
  /** 系统架构，如 x64 */
  arch: string
  /** 处理器型号 */
  processor: string
  /** 物理核心数 */
  cpuCores: number
  /** 逻辑处理器数（线程数） */
  cpuThreads: number
  /** 主频 GHz（保留 2 位小数） */
  cpuGHz: number
  /** 物理内存总量 GB */
  memTotalGB: number
  /** 可用物理内存 GB */
  memFreeGB: number
  /** 计算机名 */
  computerName: string
  /** 当前登录用户 */
  user: string
  /** 该结果的采集时间戳（ms）；来自磁盘缓存时是上次采集时间 */
  updatedAt: number
}

/** 进程内缓存：系统属性在运行期间基本不变，避免频繁起 PowerShell。 */
let cache: SystemInfo | null = null

/** 磁盘缓存路径：`%LOCALAPPDATA%/GrClean/sysinfo.json`（下次启动可直接显示上次结果）。 */
function cachePath(): string {
  return path.join(grcleanDir(), 'sysinfo.json')
}

function readCache(): SystemInfo | null {
  try {
    const o = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Partial<SystemInfo>
    // 关键字段齐全才认，避免旧版本/损坏文件导致界面半空
    if (o && typeof o.os === 'string' && typeof o.processor === 'string') {
      return o as SystemInfo
    }
  } catch {
    /* 无缓存或文件损坏：正常情况，走采集 */
  }
  return null
}

function writeCache(info: SystemInfo): void {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(info, null, 2), 'utf8')
  } catch {
    /* 写入失败不阻断主流程 */
  }
}

function gb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10
}

/**
 * 获取系统信息。
 * - force=false（默认）：进程内缓存 → 磁盘缓存 → 才真正采集；采集结果写回磁盘。
 * - force=true：忽略所有缓存重新采集（界面「刷新」按钮）。
 */
export async function getSystemInfo(force = false): Promise<SystemInfo> {
  if (!force) {
    if (cache) return cache
    const disk = readCache()
    if (disk) {
      cache = disk
      return disk
    }
  }

  // Node 原生：架构 / CPU 型号 / 线程数 / 主频 / 内存 / 计算机名 / 用户，零开销且无权限要求
  const cpus = os.cpus()
  const model = (cpus[0]?.model ?? '').trim()
  const threads = cpus.length || 1
  const mhz = cpus[0]?.speed ?? 0

  // PowerShell 补两项 Node 拿不到的信息：操作系统显示名、物理核心数
  let osName = ''
  let cores = 0
  try {
    const out = await runPs(
      "$os = Get-CimInstance Win32_OperatingSystem;" +
        "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1;" +
        "@{ n = $os.Caption; v = $os.Version; c = $cpu.NumberOfCores }" +
        " | ConvertTo-Json -Compress",
    )
    const j = JSON.parse(out.trim()) as { n?: string; v?: string; c?: number }
    osName = (j.n ?? '').replace(/^Microsoft\s*/i, '').trim()
    if (j.v) osName += ` (${j.v})`
    cores = Number(j.c) || 0
  } catch {
    // CIM 不可用（受限环境）时降级为 Node 侧信息
  }

  const info: SystemInfo = {
    os: osName || `Windows ${os.release()}`,
    arch: os.arch(),
    processor: model || '—',
    cpuCores: cores || threads,
    cpuThreads: threads,
    cpuGHz: Math.round((mhz / 100) ) / 10,
    memTotalGB: gb(os.totalmem()),
    memFreeGB: gb(os.freemem()),
    computerName: os.hostname(),
    user: os.userInfo().username || '—',
    updatedAt: Date.now(),
  }
  cache = info
  writeCache(info)
  return info
}
